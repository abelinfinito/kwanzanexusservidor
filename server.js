const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Faltava este


const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());


// CONFIGURAÇÃO DO BANCO (ANGOMONEY na Render)
const pool = new Pool({
  connectionString: 'postgresql://admin:QNrPj3x9mTVNEwtlB3Qyyxil8Qzboeyi@dpg-d6kiqcdactks739ugkq0-a.oregon-postgres.render.com/formularios_4yoj',
  ssl: { rejectUnauthorized: false }
});

// MAPA PARA GUARDAR USUÁRIOS ONLINE
const usuariosOnline = new Map();

io.on('connection', (socket) => {
    socket.on('registrar-online', (telefone) => {
        usuariosOnline.set(String(telefone), socket.id);
        console.log(`📱 Usuário ${telefone} está online.`);
    });

    socket.on('disconnect', () => {
        for (let [tel, id] of usuariosOnline.entries()) {
            if (id === socket.id) usuariosOnline.delete(tel);
        }
    });
});

function notificarSaldoUsuario(telefone, payload) {
    const socketDestino = usuariosOnline.get(String(telefone));
    if (socketDestino) {
        io.to(socketDestino).emit('atualizar-saldo', payload);
    }
}

// Criar tabela de transações se não existir
async function criarTabelasSeNaoExistirem() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                remetente_id INTEGER NOT NULL,
                remetente_nome VARCHAR(255) NOT NULL,
                destinatario_id INTEGER NOT NULL,
                destinatario_nome VARCHAR(255) NOT NULL,
                valor NUMERIC(10, 2) NOT NULL,
                data TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (remetente_id) REFERENCES usuarios(id) ON DELETE CASCADE,
                FOREIGN KEY (destinatario_id) REFERENCES usuarios(id) ON DELETE CASCADE
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS levantamentos (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                user_nome VARCHAR(255) NOT NULL,
                user_telefone VARCHAR(25) NOT NULL,
                metodo VARCHAR(30) NOT NULL DEFAULT 'unitel_money',
                unitel_telefone VARCHAR(20),
                iban VARCHAR(40),
                beneficiario_nome VARCHAR(255),
                valor NUMERIC(10, 2) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pendente',
                motivo_rejeicao TEXT,
                data_solicitacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                data_resposta TIMESTAMP,
                respondido_por VARCHAR(100),
                FOREIGN KEY (user_id) REFERENCES usuarios(id) ON DELETE CASCADE
            );
        `);
        await pool.query(`
            ALTER TABLE levantamentos
            ADD COLUMN IF NOT EXISTS metodo VARCHAR(30) NOT NULL DEFAULT 'unitel_money',
            ADD COLUMN IF NOT EXISTS unitel_telefone VARCHAR(20),
            ADD COLUMN IF NOT EXISTS iban VARCHAR(40),
            ADD COLUMN IF NOT EXISTS beneficiario_nome VARCHAR(255);
        `);
        console.log('✅ Tabelas transacoes e levantamentos verificadas/criadas com sucesso');
    } catch (e) {
        console.log('⚠️ Erro ao criar tabelas:', e.message);
    }
}

criarTabelasSeNaoExistirem();

// --- ROTA DE TRANSFERÊNCIA P2P ---
app.post('/transferir', async (req, res) => {
  const { remetenteTelefone, destinoTelefone, valor } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Buscar IDs e nomes dos usuários
    const remetenteRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [remetenteTelefone]);
    if (remetenteRes.rowCount === 0) throw new Error('Remetente não encontrado');
    const remetenteId = remetenteRes.rows[0].id;
    const remetenteName = remetenteRes.rows[0].nome_completo;

    const destinatarioRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [destinoTelefone]);
    if (destinatarioRes.rowCount === 0) throw new Error('Destinatário não encontrado');
    const destinatarioId = destinatarioRes.rows[0].id;
    const destinatarioName = destinatarioRes.rows[0].nome_completo;
    
    // Atualizar saldos
    const desc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE telefone = $2 AND saldo_usd >= $1 RETURNING saldo_usd', [valor, remetenteTelefone]);
    if (desc.rowCount === 0) throw new Error('Saldo insuficiente');
    
    const inc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE telefone = $2 RETURNING saldo_usd', [valor, destinoTelefone]);
    if (inc.rowCount === 0) throw new Error('Destinatário não encontrado');
    
    // Guardar transação na database
    await client.query(
        'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
        [remetenteId, remetenteName, destinatarioId, destinatarioName, valor]
    );
    
    await client.query('COMMIT');

    // ATUALIZAÇÃO EM TEMPO REAL
    const socketDestino = usuariosOnline.get(String(destinoTelefone));
    if (socketDestino) {
        io.to(socketDestino).emit('atualizar-saldo', { novoSaldo: inc.rows[0].saldo_usd });
    }

    res.json({ success: true, novoSaldo: desc.rows[0].saldo_usd });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// --- LEVANTAMENTOS (SAQUES) ---

app.post('/levantamentos/solicitar', async (req, res) => {
    const { userId, valor, metodo, unitelTelefone, iban, beneficiarioNome } = req.body;
    const valorNumerico = parseFloat(valor);
    const metodoNormalizado = String(metodo || '').toLowerCase();

    if (!userId || !valorNumerico || valorNumerico <= 0 || !metodoNormalizado) {
        return res.status(400).json({ success: false, error: 'Dados de levantamento inválidos.' });
    }

    if (!['unitel_money', 'iban'].includes(metodoNormalizado)) {
        return res.status(400).json({ success: false, error: 'Método de levantamento inválido.' });
    }

    if (metodoNormalizado === 'unitel_money') {
        if (!/^9\d{8}$/.test(String(unitelTelefone || ''))) {
            return res.status(400).json({ success: false, error: 'Número Unitel Money inválido. Deve começar com 9 e ter 9 dígitos.' });
        }
    }

    if (metodoNormalizado === 'iban') {
        if (!/^\d{21}$/.test(String(iban || ''))) {
            return res.status(400).json({ success: false, error: 'IBAN inválido. Deve ter 21 números.' });
        }
        if (!beneficiarioNome || String(beneficiarioNome).trim().length < 3) {
            return res.status(400).json({ success: false, error: 'Nome do beneficiário inválido.' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const usuarioRes = await client.query(
            'SELECT id, nome_completo, telefone, saldo_usd FROM usuarios WHERE id = $1 FOR UPDATE',
            [userId]
        );

        if (usuarioRes.rowCount === 0) {
            throw new Error('Usuário não encontrado.');
        }

        const usuario = usuarioRes.rows[0];
        const saldoAtual = parseFloat(usuario.saldo_usd || 0);

        if (saldoAtual < valorNumerico) {
            throw new Error('Saldo insuficiente para solicitar levantamento.');
        }

        const novoSaldoRes = await client.query(
            'UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 RETURNING saldo_usd',
            [valorNumerico, userId]
        );

        const levantamentoRes = await client.query(
            `INSERT INTO levantamentos (
                user_id, user_nome, user_telefone, metodo, unitel_telefone, iban, beneficiario_nome, valor, status, data_solicitacao
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW())
             RETURNING *`,
            [
                userId,
                usuario.nome_completo,
                usuario.telefone,
                metodoNormalizado,
                metodoNormalizado === 'unitel_money' ? String(unitelTelefone) : null,
                metodoNormalizado === 'iban' ? String(iban) : null,
                metodoNormalizado === 'iban' ? String(beneficiarioNome).trim() : null,
                valorNumerico
            ]
        );

        await client.query('COMMIT');

        const novoSaldo = parseFloat(novoSaldoRes.rows[0].saldo_usd);
        notificarSaldoUsuario(usuario.telefone, {
            novoSaldo,
            mensagem: `Seu levantamento de $${valorNumerico.toFixed(2)} foi solicitado e está pendente.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(userId),
            levantamentoId: levantamentoRes.rows[0].id,
            status: 'pendente'
        });

        res.json({
            success: true,
            novoSaldo,
            levantamento: levantamentoRes.rows[0]
        });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.get('/levantamentos/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, user_nome, user_telefone, metodo, unitel_telefone, iban, beneficiario_nome, valor, status, motivo_rejeicao,
                    data_solicitacao, data_resposta
             FROM levantamentos
             WHERE user_id = $1
             ORDER BY data_solicitacao DESC`,
            [req.params.userId]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/admin/levantamentos', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, user_nome, user_telefone, metodo, unitel_telefone, iban, beneficiario_nome, valor, status, motivo_rejeicao,
                    data_solicitacao, data_resposta
             FROM levantamentos
             ORDER BY
                CASE status
                    WHEN 'pendente' THEN 1
                    WHEN 'pago' THEN 2
                    ELSE 3
                END,
                data_solicitacao DESC`
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/levantamentos/:id/aprovar', async (req, res) => {
    const { senhaAdmin } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== '123') {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const levantamentoRes = await client.query(
            `SELECT id, user_id, user_telefone, user_nome, valor, status
             FROM levantamentos
             WHERE id = $1
             FOR UPDATE`,
            [levantamentoId]
        );

        if (levantamentoRes.rowCount === 0) {
            throw new Error('Levantamento não encontrado.');
        }

        const levantamento = levantamentoRes.rows[0];
        if (levantamento.status !== 'pendente') {
            throw new Error('Este levantamento já foi processado.');
        }

        await client.query(
            `UPDATE levantamentos
             SET status = 'pago', data_resposta = NOW(), respondido_por = 'admin'
             WHERE id = $1`,
            [levantamentoId]
        );

        const saldoRes = await client.query(
            'SELECT saldo_usd FROM usuarios WHERE id = $1',
            [levantamento.user_id]
        );

        await client.query('COMMIT');

        const saldoAtual = saldoRes.rowCount > 0 ? parseFloat(saldoRes.rows[0].saldo_usd) : 0;
        notificarSaldoUsuario(levantamento.user_telefone, {
            novoSaldo: saldoAtual,
            mensagem: `Seu levantamento de $${parseFloat(levantamento.valor).toFixed(2)} foi pago.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(levantamento.user_id),
            levantamentoId: Number(levantamentoId),
            status: 'pago'
        });

        res.json({ success: true, mensagem: 'Levantamento aprovado com sucesso.' });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.post('/admin/levantamentos/:id/rejeitar', async (req, res) => {
    const { senhaAdmin, motivo } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== '123') {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const levantamentoRes = await client.query(
            `SELECT id, user_id, user_telefone, user_nome, valor, status
             FROM levantamentos
             WHERE id = $1
             FOR UPDATE`,
            [levantamentoId]
        );

        if (levantamentoRes.rowCount === 0) {
            throw new Error('Levantamento não encontrado.');
        }

        const levantamento = levantamentoRes.rows[0];
        if (levantamento.status !== 'pendente') {
            throw new Error('Este levantamento já foi processado.');
        }

        const saldoRes = await client.query(
            'UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd',
            [levantamento.valor, levantamento.user_id]
        );

        await client.query(
            `UPDATE levantamentos
             SET status = 'rejeitado',
                 motivo_rejeicao = $2,
                 data_resposta = NOW(),
                 respondido_por = 'admin'
             WHERE id = $1`,
            [levantamentoId, motivo || null]
        );

        await client.query('COMMIT');

        const saldoAtual = parseFloat(saldoRes.rows[0].saldo_usd);
        notificarSaldoUsuario(levantamento.user_telefone, {
            novoSaldo: saldoAtual,
            mensagem: `Seu levantamento de $${parseFloat(levantamento.valor).toFixed(2)} foi rejeitado. O valor voltou para sua conta.`
        });

        io.emit('atualizar-levantamentos', {
            userId: Number(levantamento.user_id),
            levantamentoId: Number(levantamentoId),
            status: 'rejeitado'
        });

        res.json({ success: true, mensagem: 'Levantamento rejeitado e saldo devolvido.' });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.post('/admin/levantamentos/:id/eliminar', async (req, res) => {
    const { senhaAdmin } = req.body;
    const levantamentoId = req.params.id;

    if (senhaAdmin !== '123') {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    try {
        const result = await pool.query(
            'DELETE FROM levantamentos WHERE id = $1 RETURNING user_id',
            [levantamentoId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Levantamento não encontrado.' });
        }

        io.emit('atualizar-levantamentos', {
            userId: Number(result.rows[0].user_id),
            levantamentoId: Number(levantamentoId),
            status: 'eliminado'
        });

        res.json({ success: true, mensagem: 'Registo de levantamento eliminado com sucesso.' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- OUTRAS ROTAS (LOGIN/CADASTRO/BUSCA) ---

app.post('/auth/cadastro', async (req, res) => {
    const { nome, telefone, senha } = req.body;
    
    try {
        // 1. PRIMEIRO: Verificamos se o número já existe
        const checkUser = await pool.query('SELECT id FROM usuarios WHERE telefone = $1', [telefone]);
        
        if (checkUser.rows.length > 0) {
            // Se encontrar alguém, paramos aqui e avisamos
            return res.status(400).json({ 
                success: false, 
                error: 'Este número já está registado' 
            });
        }

        // 2. SE NÃO EXISTIR: Aí sim fazemos o cadastro
        const query = 'INSERT INTO usuarios (nome_completo, telefone, senha, saldo_usd) VALUES ($1, $2, $3, 2) RETURNING *';
        const result = await pool.query(query, [nome, telefone, senha]);
        
        res.status(201).json({ success: true, usuario: result.rows[0] });

    } catch (err) {
        console.error("Erro no processo:", err.message);
        res.status(500).json({ success: false, error: 'Erro ao processar o cadastro.' });
    }
});

app.post('/auth/login', async (req, res) => {
    const { telefone, senha } = req.body;
    try {
      const result = await pool.query('SELECT * FROM usuarios WHERE telefone = $1 AND senha = $2', [telefone, senha]);
      if (result.rows.length > 0) res.json({ success: true, usuario: result.rows[0] });
      else res.status(401).json({ error: 'Dados incorretos' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});
// --- 1. BUSCA CORRIGIDA (Agora envia ID e Saldo) ---
app.get('/buscar-usuario/:telefone', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome_completo AS nome, telefone, saldo_usd, senha FROM usuarios WHERE telefone = $1', [req.params.telefone]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ error: 'Não encontrado' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

// --- 2. NOVA ROTA: TOTAL DA PLATAFORMA ---
app.get('/admin/total-plataforma', async (req, res) => {
    try {
        const result = await pool.query('SELECT SUM(saldo_usd) as total FROM usuarios');
        res.json({ total: result.rows[0].total || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. NOVA ROTA: TOTAL DE USUÁRIOS CADASTRADOS ---
app.get('/admin/total-usuarios', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as total FROM usuarios');
        res.json({ total: parseInt(result.rows[0].total) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/listar-usuarios', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, nome_completo AS nome, telefone, saldo_usd FROM usuarios ORDER BY id DESC LIMIT 500'
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/admin/usuario-mais-rico', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, nome_completo AS nome, telefone, saldo_usd FROM usuarios ORDER BY saldo_usd DESC LIMIT 1'
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Nenhum utilizador encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/alterar-senha', async (req, res) => {
    const { userId, novaSenha, senhaAdmin } = req.body;

    if (senhaAdmin !== '123') {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }

    if (!novaSenha || String(novaSenha).trim().length < 4) {
        return res.status(400).json({ success: false, error: 'Nova senha inválida.' });
    }

    try {
        const result = await pool.query(
            'UPDATE usuarios SET senha = $1 WHERE id = $2 RETURNING id',
            [String(novaSenha).trim(), userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Utilizador não encontrado.' });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/ajustar-saldo', async (req, res) => {
    const { userId, valor, operacao } = req.body;
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        let query;
        let params = [valor, userId];

        if (operacao === 'soma') {
            query = 'UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd, telefone, nome_completo';
        } else {
            // AQUI ESTÁ A TRAVA: Só subtrai se o saldo atual for maior ou igual ao valor pedido
            query = 'UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd, telefone, nome_completo';
        }
        
        const result = await client.query(query, params);

        if (result.rowCount > 0) {
            const { saldo_usd, telefone, nome_completo } = result.rows[0];

            // Registrar no histórico de transações
            const tipoTransacao = operacao === 'soma' ? 'Depósito' : 'Levantamento';
            const valorRegistro = operacao === 'soma' ? valor : -valor;
            
            await client.query(
                'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
                [userId, tipoTransacao, userId, tipoTransacao, valorRegistro]
            );

            await client.query('COMMIT');

            // Notificação em tempo real via Socket.io
            const socketDestino = usuariosOnline.get(String(telefone));
            if (socketDestino) {
                io.to(socketDestino).emit('atualizar-saldo', { 
                    novoSaldo: saldo_usd,
                    mensagem: `Administrador ${operacao === 'soma' ? 'adicionou' : 'removeu'} $${valor} na sua conta.`
                });
            }

            res.json({ success: true, novoSaldo: saldo_usd });
        } else {
            await client.query('ROLLBACK');
            // Se o rowCount for 0 na subtração, significa que o saldo era insuficiente
            const erroMsg = operacao === 'subtracao' || operacao === 'subtrair' 
                ? "Saldo insuficiente na conta do usuário para realizar esta operação." 
                : "Usuário não encontrado.";
            res.status(400).json({ success: false, error: erroMsg });
        }
    } catch (e) { 
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: e.message }); 
    } finally {
        client.release();
    }
});

// --- 4. ROTA PARA DISTRIBUIR BÓNUS GLOBAL ---
app.post('/admin/bonus-global', async (req, res) => {
    const { valor } = req.body;
    try {
        // Atualiza o saldo de TODOS os usuários
        const result = await pool.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 RETURNING id, saldo_usd, telefone', [valor]);

        if (result.rows.length > 0) {
            // Notifica todos os usuários online em tempo real
            result.rows.forEach((usuario) => {
                const socketDestino = usuariosOnline.get(String(usuario.telefone));
                if (socketDestino) {
                    io.to(socketDestino).emit('atualizar-saldo', {
                        novoSaldo: usuario.saldo_usd,
                        mensagem: `🎁 Você recebeu um bónus de $${valor} do administrador!`
                    });
                }
            });

            res.json({ success: true, usuariosAtualizados: result.rows.length, mensagem: `Bónus de $${valor} enviado para ${result.rows.length} utilizadores.` });
        } else {
            res.status(400).json({ success: false, error: "Nenhum utilizador encontrado." });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- 5. ROTA PARA ELIMINAR USUÁRIO ---
app.post('/admin/eliminar-usuario', async (req, res) => {
    const { userId, senha } = req.body;
    
    // Verificar a senha admin (123)
    if (senha !== '123') {
        return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
    }
    
    try {
        const result = await pool.query('DELETE FROM investimentos WHERE user_id = $1', [userId]);
        const deleteUser = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING telefone, nome_completo', [userId]);
        
        if (deleteUser.rowCount > 0) {
            res.json({ success: true, mensagem: `Utilizador ${deleteUser.rows[0].nome_completo} eliminado com sucesso.` });
        } else {
            res.status(404).json({ success: false, error: 'Utilizador não encontrado.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// BUSCAR HISTÓRICO DE TRANSAÇÕES DO USUÁRIO
app.get('/historico/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);

    const result = await pool.query(
      `SELECT 
        id,
        remetente_id,
        remetente_nome,
        destinatario_id,
        destinatario_nome,
        valor,
        data
      FROM transacoes 
      WHERE remetente_id = $1 OR destinatario_id = $1 
      ORDER BY data DESC`, 
      [userId]
    );

    const levantamentosRes = await pool.query(
      `SELECT
        id,
        valor,
        status,
        data_solicitacao,
        data_resposta,
        motivo_rejeicao
      FROM levantamentos
      WHERE user_id = $1
      ORDER BY data_solicitacao DESC`,
      [userId]
    );
    
    // Formatar os dados para o frontend
    const transacoes = result.rows.map(t => {
      let titulo = '';
      let icon = '📌';
      let tipo = '';
      
      if (t.remetente_nome === 'Investimento') {
        titulo = `Investimento de $${Math.abs(t.valor).toFixed(2)}`;
        icon = '💰';
        tipo = 'investimento';
      } else if (t.remetente_nome === 'Ganho do investimento') {
        titulo = 'Ganho do investimento';
        icon = '📈';
        tipo = 'ganho';
      } else if (t.remetente_nome === 'Depósito') {
        titulo = 'Depósito (Admin)';
        icon = '💵';
        tipo = 'deposito';
      } else if (t.remetente_nome === 'Levantamento') {
        titulo = 'Levantamento (Admin)';
        icon = '🏦';
        tipo = 'levantamento';
      } else if (t.remetente_id === userId) {
        titulo = `Enviou para ${t.destinatario_nome}`;
        icon = '📤';
        tipo = 'enviado';
      } else {
        titulo = `Recebeu de ${t.remetente_nome}`;
        icon = '📥';
        tipo = 'recebido';
      }
      
      return {
        id: t.id,
        titulo: titulo,
        tipo: tipo,
        valor: parseFloat(t.valor),
        data: t.data,
        icon: icon,
        nome: t.remetente_nome
      };
    });

    const historicoLevantamentos = levantamentosRes.rows.map(l => {
      const valor = Math.abs(parseFloat(l.valor));
      const status = String(l.status || 'pendente').toLowerCase();

      if (status === 'pago') {
        return {
          id: `levantamento-${l.id}`,
          titulo: 'Levantamento pago',
          tipo: 'levantamento_pago',
          valor: -valor,
          data: l.data_resposta || l.data_solicitacao,
          icon: '✅',
          nome: 'Levantamento',
          status
        };
      }

      if (status === 'rejeitado') {
        return {
          id: `levantamento-${l.id}`,
          titulo: 'Levantamento rejeitado (valor devolvido)',
          tipo: 'levantamento_rejeitado',
          valor: valor,
          data: l.data_resposta || l.data_solicitacao,
          icon: '↩️',
          nome: 'Levantamento',
          status
        };
      }

      return {
        id: `levantamento-${l.id}`,
        titulo: 'Levantamento pendente',
        tipo: 'levantamento_pendente',
        valor: -valor,
        data: l.data_solicitacao,
        icon: '🏦',
        nome: 'Levantamento',
        status
      };
    });
    
    const historicoCompleto = [...transacoes, ...historicoLevantamentos].sort(
      (a, b) => new Date(b.data) - new Date(a.data)
    );

    res.json(historicoCompleto);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// BUSCAR INVESTIMENTOS DO USUÁRIO
app.get('/meus-investimentos/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT *, CAST(EXTRACT(DAY FROM (data_fim - CURRENT_DATE)) AS INTEGER) as dias_restantes FROM investimentos WHERE user_id = $1 ORDER BY data_fim DESC", 
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar investimentos' });
  }
});
// ROTA PARA CRIAR INVESTIMENTO
app.post('/investir', async (req, res) => {
  const { userId, valor, taxa, dias } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Tira o dinheiro do saldo
    const desc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd', [valor, userId]);
    if (desc.rowCount === 0) throw new Error('Saldo insuficiente para investir');

    // 2. Calcula o retorno e a data final
    const retorno = valor + (valor * taxa);
    await client.query(
        'INSERT INTO investimentos (user_id, valor_investido_usd, valor_retorno_usd, data_fim) VALUES ($1, $2, $3, CURRENT_DATE + $4 * INTERVAL \'1 day\')',
        [userId, valor, retorno, dias]
    );

    // Guardar investimento no histórico
    await client.query(
        'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
        [userId, 'Sistema', userId, 'Investimento', -valor]
    );

    await client.query('COMMIT');
    res.json({ success: true, novoSaldo: desc.rows[0].saldo_usd, retornoTotal: retorno });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ROTA PARA RESGATAR INVESTIMENTO
app.post('/resgatar-investimento', async (req, res) => {
  const { investmentId, userId } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Buscar o investimento
    const invRes = await client.query(
      'SELECT * FROM investimentos WHERE id = $1 AND user_id = $2',
      [investmentId, userId]
    );
    
    if (invRes.rowCount === 0) {
      throw new Error('Investimento não encontrado');
    }
    
    const investimento = invRes.rows[0];
    
    // 2. Validar se venceu (VALIDAÇÃO NO SERVIDOR)
    const dataFimCheck = await client.query(
      'SELECT CURRENT_DATE >= data_fim as venceu, data_fim FROM investimentos WHERE id = $1',
      [investmentId]
    );
    
    if (!dataFimCheck.rows[0].venceu) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        success: false, 
        vencido: false,
        dataFim: dataFimCheck.rows[0].data_fim,
        error: 'Prazo ainda não venceu' 
      });
    }
    
    // 3. Adicionar valor ao saldo
    const saldoRes = await client.query(
      'UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd, nome_completo',
      [investimento.valor_retorno_usd, userId]
    );
    
    // 4. Registrar no histórico como ganho
    await client.query(
      'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
      [userId, 'Ganho do investimento', userId, 'Ganho do investimento', investimento.valor_retorno_usd]
    );
    
    // 5. Remover o investimento
    await client.query('DELETE FROM investimentos WHERE id = $1', [investmentId]);
    
    await client.query('COMMIT');
    
    res.json({ 
      success: true,
      novoSaldo: saldoRes.rows[0].saldo_usd,
      valorRecebido: investimento.valor_retorno_usd
    });
    
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});


// --- INICIALIZAÇÃO ---

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => {
    console.log(`🚀 API KWANZA NEXUS na Render ativa!`);
});
