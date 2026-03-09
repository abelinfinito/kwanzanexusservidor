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


// CONFIGURAГ‡ГѓO DO BANCO (ANGOMONEY na Render)
const pool = new Pool({
  connectionString: 'postgresql://admin:QNrPj3x9mTVNEwtlB3Qyyxil8Qzboeyi@dpg-d6kiqcdactks739ugkq0-a.oregon-postgres.render.com/formularios_4yoj',
  ssl: { rejectUnauthorized: false }
});

// MAPA PARA GUARDAR USUГЃRIOS ONLINE
const usuariosOnline = new Map();

io.on('connection', (socket) => {
    socket.on('registrar-online', (telefone) => {
        usuariosOnline.set(String(telefone), socket.id);
        console.log(`рџ“± UsuГЎrio ${telefone} estГЎ online.`);
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

// Criar tabela de transaГ§Гµes se nГЈo existir
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
        await pool.query(`
            CREATE TABLE IF NOT EXISTS historico_excluido (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                registro_tipo VARCHAR(30) NOT NULL,
                registro_id INTEGER NOT NULL,
                data_exclusao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, registro_tipo, registro_id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id) ON DELETE CASCADE
            );
        `);
        console.log('вњ… Tabelas transacoes, levantamentos e historico_excluido verificadas/criadas com sucesso');
    } catch (e) {
        console.log('вљ пёЏ Erro ao criar tabelas:', e.message);
    }
}

criarTabelasSeNaoExistirem();

// --- ROTA DE TRANSFERГЉNCIA P2P ---
app.post('/transferir', async (req, res) => {
  const { remetenteTelefone, destinoTelefone, valor } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Buscar IDs e nomes dos usuГЎrios
    const remetenteRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [remetenteTelefone]);
    if (remetenteRes.rowCount === 0) throw new Error('Remetente nГЈo encontrado');
    const remetenteId = remetenteRes.rows[0].id;
    const remetenteName = remetenteRes.rows[0].nome_completo;

    const destinatarioRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [destinoTelefone]);
    if (destinatarioRes.rowCount === 0) throw new Error('DestinatГЎrio nГЈo encontrado');
    const destinatarioId = destinatarioRes.rows[0].id;
    const destinatarioName = destinatarioRes.rows[0].nome_completo;
    
    // Atualizar saldos
    const desc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE telefone = $2 AND saldo_usd >= $1 RETURNING saldo_usd', [valor, remetenteTelefone]);
    if (desc.rowCount === 0) throw new Error('Saldo insuficiente');
    
    const inc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE telefone = $2 RETURNING saldo_usd', [valor, destinoTelefone]);
    if (inc.rowCount === 0) throw new Error('DestinatГЎrio nГЈo encontrado');
    
    // Guardar transaГ§ГЈo na database
    await client.query(
        'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
        [remetenteId, remetenteName, destinatarioId, destinatarioName, valor]
    );
    
    await client.query('COMMIT');

    // ATUALIZAГ‡ГѓO EM TEMPO REAL
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
    const VALOR_MINIMO_LEVANTAMENTO = 3;

    if (!userId || !valorNumerico || valorNumerico <= 0 || !metodoNormalizado) {
        return res.status(400).json({ success: false, error: 'Dados de levantamento invГЎlidos.' });
    }

    if (valorNumerico < VALOR_MINIMO_LEVANTAMENTO) {
        return res.status(400).json({ success: false, error: 'O valor minimo para levantamento e 3.00 USD.' });
    }

    if (!['unitel_money', 'iban'].includes(metodoNormalizado)) {
        return res.status(400).json({ success: false, error: 'MГ©todo de levantamento invГЎlido.' });
    }

    if (metodoNormalizado === 'unitel_money') {
        if (!/^9\d{8}$/.test(String(unitelTelefone || ''))) {
            return res.status(400).json({ success: false, error: 'NГєmero Unitel Money invГЎlido. Deve comeГ§ar com 9 e ter 9 dГ­gitos.' });
        }
    }

    if (metodoNormalizado === 'iban') {
        if (!/^\d{21}$/.test(String(iban || ''))) {
            return res.status(400).json({ success: false, error: 'IBAN invГЎlido. Deve ter 21 nГєmeros.' });
        }
        if (!beneficiarioNome || String(beneficiarioNome).trim().length < 3) {
            return res.status(400).json({ success: false, error: 'Nome do beneficiГЎrio invГЎlido.' });
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
            throw new Error('UsuГЎrio nГЈo encontrado.');
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
            mensagem: `Seu levantamento de $${valorNumerico.toFixed(2)} foi solicitado e estГЎ pendente.`
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
            throw new Error('Levantamento nГЈo encontrado.');
        }

        const levantamento = levantamentoRes.rows[0];
        if (levantamento.status !== 'pendente') {
            throw new Error('Este levantamento jГЎ foi processado.');
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
            throw new Error('Levantamento nГЈo encontrado.');
        }

        const levantamento = levantamentoRes.rows[0];
        if (levantamento.status !== 'pendente') {
            throw new Error('Este levantamento jГЎ foi processado.');
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
            return res.status(404).json({ success: false, error: 'Levantamento nГЈo encontrado.' });
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
        // 1. PRIMEIRO: Verificamos se o nГєmero jГЎ existe
        const checkUser = await pool.query('SELECT id FROM usuarios WHERE telefone = $1', [telefone]);
        
        if (checkUser.rows.length > 0) {
            // Se encontrar alguГ©m, paramos aqui e avisamos
            return res.status(400).json({ 
                success: false, 
                error: 'Este nГєmero jГЎ estГЎ registado' 
            });
        }

        // 2. SE NГѓO EXISTIR: AГ­ sim fazemos o cadastro
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
        else res.status(404).json({ error: 'NГЈo encontrado' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.get('/admin/investimentos-usuario/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Utilizador invalido.' });
        }

        const usuarioRes = await pool.query(
            'SELECT id, nome_completo AS nome, telefone, saldo_usd FROM usuarios WHERE id = $1',
            [userId]
        );

        if (usuarioRes.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Utilizador nao encontrado.' });
        }

        const investimentosRes = await pool.query(
            "SELECT *, CAST(EXTRACT(DAY FROM (data_fim - CURRENT_DATE)) AS INTEGER) AS dias_restantes FROM investimentos WHERE user_id = $1 ORDER BY data_fim DESC",
            [userId]
        );

        res.json({
            success: true,
            usuario: usuarioRes.rows[0],
            investimentos: investimentosRes.rows
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- 2. NOVA ROTA: TOTAL DA PLATAFORMA ---
app.get('/admin/total-plataforma', async (req, res) => {
    try {
        const result = await pool.query('SELECT SUM(saldo_usd) as total FROM usuarios');
        res.json({ total: result.rows[0].total || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- 3. NOVA ROTA: TOTAL DE USUГЃRIOS CADASTRADOS ---
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
        return res.status(400).json({ success: false, error: 'Nova senha invГЎlida.' });
    }

    try {
        const result = await pool.query(
            'UPDATE usuarios SET senha = $1 WHERE id = $2 RETURNING id',
            [String(novaSenha).trim(), userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Utilizador nГЈo encontrado.' });
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
            // AQUI ESTГЃ A TRAVA: SГі subtrai se o saldo atual for maior ou igual ao valor pedido
            query = 'UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd, telefone, nome_completo';
        }
        
        const result = await client.query(query, params);

        if (result.rowCount > 0) {
            const { saldo_usd, telefone, nome_completo } = result.rows[0];

            // Registrar no histГіrico de transaГ§Гµes
            const tipoTransacao = operacao === 'soma' ? 'DepГіsito' : 'Levantamento';
            const valorRegistro = operacao === 'soma' ? valor : -valor;
            
            await client.query(
                'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
                [userId, tipoTransacao, userId, tipoTransacao, valorRegistro]
            );

            await client.query('COMMIT');

            // NotificaГ§ГЈo em tempo real via Socket.io
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
            // Se o rowCount for 0 na subtraГ§ГЈo, significa que o saldo era insuficiente
            const erroMsg = operacao === 'subtracao' || operacao === 'subtrair' 
                ? "Saldo insuficiente na conta do usuГЎrio para realizar esta operaГ§ГЈo." 
                : "UsuГЎrio nГЈo encontrado.";
            res.status(400).json({ success: false, error: erroMsg });
        }
    } catch (e) { 
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: e.message }); 
    } finally {
        client.release();
    }
});

// --- 4. ROTA PARA DISTRIBUIR BГ“NUS GLOBAL ---
app.post('/admin/bonus-global', async (req, res) => {
    const { valor } = req.body;
    try {
        // Atualiza o saldo de TODOS os usuГЎrios
        const result = await pool.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 RETURNING id, saldo_usd, telefone', [valor]);

        if (result.rows.length > 0) {
            // Notifica todos os usuГЎrios online em tempo real
            result.rows.forEach((usuario) => {
                const socketDestino = usuariosOnline.get(String(usuario.telefone));
                if (socketDestino) {
                    io.to(socketDestino).emit('atualizar-saldo', {
                        novoSaldo: usuario.saldo_usd,
                        mensagem: `рџЋЃ VocГЄ recebeu um bГіnus de $${valor} do administrador!`
                    });
                }
            });

            res.json({ success: true, usuariosAtualizados: result.rows.length, mensagem: `BГіnus de $${valor} enviado para ${result.rows.length} utilizadores.` });
        } else {
            res.status(400).json({ success: false, error: "Nenhum utilizador encontrado." });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- 5. ROTA PARA ELIMINAR USUГЃRIO ---
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
            res.status(404).json({ success: false, error: 'Utilizador nГЈo encontrado.' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// BUSCAR HISTГ“RICO DE TRANSAГ‡Г•ES DO USUГЃRIO
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

    const historicoExcluidoRes = await pool.query(
      `SELECT registro_tipo, registro_id
       FROM historico_excluido
       WHERE user_id = $1`,
      [userId]
    );
    const historicoExcluidoSet = new Set(
      historicoExcluidoRes.rows.map(r => `${String(r.registro_tipo)}-${Number(r.registro_id)}`)
    );
    
    // Formatar os dados para o frontend
    const transacoes = result.rows
      .filter(t => !historicoExcluidoSet.has(`transacao-${Number(t.id)}`))
      .map(t => {
      let titulo = '';
      let icon = 'рџ“Њ';
      let tipo = '';
      const remetenteNome = String(t.remetente_nome || '').toLowerCase();
      const destinatarioNome = String(t.destinatario_nome || '').toLowerCase();
      
      if (destinatarioNome === 'investimento' || remetenteNome === 'investimento') {
        titulo = `Investimento de $${Math.abs(t.valor).toFixed(2)}`;
        icon = 'рџ’°';
        tipo = 'investimento';
      } else if (remetenteNome === 'ganho do investimento' || destinatarioNome === 'ganho do investimento') {
        titulo = 'Ganho do investimento';
        icon = 'рџ“€';
        tipo = 'ganho';
      } else if (remetenteNome === 'cancelamento de investimento' || destinatarioNome === 'cancelamento de investimento') {
        titulo = 'Cancelamento do plano a prazo';
        icon = 'в†©пёЏ';
        tipo = 'cancelamento_investimento';
      } else if (t.remetente_nome === 'DepГіsito') {
        titulo = 'DepГіsito (Admin)';
        icon = 'рџ’µ';
        tipo = 'deposito';
      } else if (t.remetente_nome === 'Levantamento') {
        titulo = 'Levantamento (Admin)';
        icon = 'рџЏ¦';
        tipo = 'levantamento';
      } else if (t.remetente_id === userId) {
        titulo = `Enviou para ${t.destinatario_nome}`;
        icon = 'рџ“¤';
        tipo = 'enviado';
      } else {
        titulo = `Recebeu de ${t.remetente_nome}`;
        icon = 'рџ“Ґ';
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

    const historicoLevantamentos = levantamentosRes.rows
      .filter(l => !historicoExcluidoSet.has(`levantamento-${Number(l.id)}`))
      .map(l => {
      const valor = Math.abs(parseFloat(l.valor));
      const status = String(l.status || 'pendente').toLowerCase();

      if (status === 'pago') {
        return {
          id: `levantamento-${l.id}`,
          titulo: 'Levantamento pago',
          tipo: 'levantamento_pago',
          valor: -valor,
          data: l.data_resposta || l.data_solicitacao,
          icon: 'вњ…',
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
          icon: 'в†©пёЏ',
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
        icon: 'рџЏ¦',
        nome: 'Levantamento',
        status
      };
    });
    
    const historicoCompleto = [...transacoes, ...historicoLevantamentos].sort(
      (a, b) => new Date(b.data) - new Date(a.data)
    );

    res.json(historicoCompleto);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histГіrico' });
  }
});

app.post('/historico/eliminar', async (req, res) => {
  const { userId, registroId } = req.body;
  const userIdNum = parseInt(userId);
  const registroIdTexto = String(registroId || '');

  if (!Number.isInteger(userIdNum) || userIdNum <= 0 || !registroIdTexto.includes('-')) {
    return res.status(400).json({ success: false, error: 'Dados invalidos para eliminar historico.' });
  }

  const partes = registroIdTexto.split('-');
  const registroTipo = partes[0];
  const idNum = parseInt(partes[1]);

  if (!['transacao', 'levantamento'].includes(registroTipo) || !Number.isInteger(idNum) || idNum <= 0) {
    return res.status(400).json({ success: false, error: 'Registro de historico invalido.' });
  }

  try {
    if (registroTipo === 'transacao') {
      const donoRes = await pool.query(
        `SELECT id FROM transacoes
         WHERE id = $1 AND (remetente_id = $2 OR destinatario_id = $2)`,
        [idNum, userIdNum]
      );
      if (donoRes.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Transacao nao encontrada para este utilizador.' });
      }
    } else {
      const donoRes = await pool.query(
        'SELECT id FROM levantamentos WHERE id = $1 AND user_id = $2',
        [idNum, userIdNum]
      );
      if (donoRes.rowCount === 0) {
        return res.status(404).json({ success: false, error: 'Levantamento nao encontrado para este utilizador.' });
      }
    }

    await pool.query(
      `INSERT INTO historico_excluido (user_id, registro_tipo, registro_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, registro_tipo, registro_id) DO NOTHING`,
      [userIdNum, registroTipo, idNum]
    );

    io.emit('atualizar-historico', { userId: userIdNum, registroTipo, registroId: idNum });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// BUSCAR INVESTIMENTOS DO USUГЃRIO
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
    const desc = await client.query(
      'UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd, telefone',
      [valor, userId]
    );
    if (desc.rowCount === 0) throw new Error('Saldo insuficiente para investir');

    // 2. Calcula o retorno e a data final
    const retorno = valor + (valor * taxa);
    await client.query(
        'INSERT INTO investimentos (user_id, valor_investido_usd, valor_retorno_usd, data_fim) VALUES ($1, $2, $3, CURRENT_DATE + $4 * INTERVAL \'1 day\')',
        [userId, valor, retorno, dias]
    );

    // Guardar investimento no histГіrico
    await client.query(
        'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
        [userId, 'Sistema', userId, 'Investimento', -valor]
    );

    await client.query('COMMIT');

    const novoSaldo = parseFloat(desc.rows[0].saldo_usd);
    notificarSaldoUsuario(desc.rows[0].telefone, {
      novoSaldo,
      mensagem: 'Novo investimento aplicado com sucesso.'
    });
    io.emit('atualizar-investimentos', { userId: Number(userId), acao: 'criado' });

    res.json({ success: true, novoSaldo, retornoTotal: retorno });
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
      throw new Error('Investimento nГЈo encontrado');
    }
    
    const investimento = invRes.rows[0];
    
    // 2. Validar se venceu (VALIDAГ‡ГѓO NO SERVIDOR)
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
        error: 'Prazo ainda nГЈo venceu' 
      });
    }
    
    // 3. Adicionar valor ao saldo
    const saldoRes = await client.query(
      'UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd, nome_completo, telefone',
      [investimento.valor_retorno_usd, userId]
    );
    
    // 4. Registrar no histГіrico como ganho
    await client.query(
      'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
      [userId, 'Ganho do investimento', userId, 'Ganho do investimento', investimento.valor_retorno_usd]
    );
    
    // 5. Remover o investimento
    await client.query('DELETE FROM investimentos WHERE id = $1', [investmentId]);
    
    await client.query('COMMIT');

    const novoSaldo = parseFloat(saldoRes.rows[0].saldo_usd);
    notificarSaldoUsuario(saldoRes.rows[0].telefone, {
      novoSaldo,
      mensagem: `Investimento resgatado: $${parseFloat(investimento.valor_retorno_usd).toFixed(2)} creditado.`
    });
    io.emit('atualizar-investimentos', { userId: Number(userId), investmentId: Number(investmentId), acao: 'resgatado' });
    
    res.json({ 
      success: true,
      novoSaldo,
      valorRecebido: investimento.valor_retorno_usd
    });
    
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});

app.post('/admin/investimentos/:id/cancelar', async (req, res) => {
  const investimentoId = parseInt(req.params.id);
  const { senhaAdmin } = req.body;

  if (senhaAdmin !== '123') {
    return res.status(401).json({ success: false, error: 'Senha de administrador incorreta.' });
  }

  if (!Number.isInteger(investimentoId) || investimentoId <= 0) {
    return res.status(400).json({ success: false, error: 'Investimento invalido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const investimentoRes = await client.query(
      `SELECT i.id, i.user_id, i.valor_investido_usd, u.telefone
       FROM investimentos i
       INNER JOIN usuarios u ON u.id = i.user_id
       WHERE i.id = $1
       FOR UPDATE`,
      [investimentoId]
    );

    if (investimentoRes.rowCount === 0) {
      throw new Error('Investimento nao encontrado.');
    }

    const investimento = investimentoRes.rows[0];
    const valorDevolvido = parseFloat(investimento.valor_investido_usd);

    const saldoRes = await client.query(
      'UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd',
      [valorDevolvido, investimento.user_id]
    );

    await client.query(
      'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
      [investimento.user_id, 'Cancelamento de investimento', investimento.user_id, 'Cancelamento de investimento', valorDevolvido]
    );

    await client.query('DELETE FROM investimentos WHERE id = $1', [investimentoId]);

    await client.query('COMMIT');

    const novoSaldo = parseFloat(saldoRes.rows[0].saldo_usd);
    notificarSaldoUsuario(investimento.telefone, {
      novoSaldo,
      mensagem: `Investimento cancelado pelo administrador. $${valorDevolvido.toFixed(2)} devolvido.`
    });
    io.emit('atualizar-investimentos', { userId: Number(investimento.user_id), investmentId: investimentoId, acao: 'cancelado_admin' });

    res.json({
      success: true,
      userId: Number(investimento.user_id),
      novoSaldo,
      valorDevolvido
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});


// --- INICIALIZAГ‡ГѓO ---

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => {
    console.log(`рџљЂ API KWANZA NEXUS na Render ativa!`);
});

