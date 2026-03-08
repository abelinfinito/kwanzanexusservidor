const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
        console.log('✅ Tabela transacoes verificada/criada com sucesso');
    } catch (e) {
        console.log('⚠️ Erro ao criar tabela transacoes:', e.message);
    }
}

criarTabelasSeNaoExistirem();

// ==========================================
//           ROTAS DE AUTENTICAÇÃO
// ==========================================

app.post('/auth/cadastro', async (req, res) => {
    const { nome, telefone, senha } = req.body;
    try {
      const query = 'INSERT INTO usuarios (nome_completo, telefone, senha, saldo_usd) VALUES ($1, $2, $3, 2) RETURNING *';
      const result = await pool.query(query, [nome, telefone, senha]);
      res.status(201).json({ success: true, usuario: result.rows[0] });
    } catch (err) { res.status(400).json({ error: 'Erro no cadastro.' }); }
});

app.post('/auth/login', async (req, res) => {
    const { telefone, senha } = req.body;
    try {
      const result = await pool.query('SELECT * FROM usuarios WHERE telefone = $1 AND senha = $2', [telefone, senha]);
      if (result.rows.length > 0) res.json({ success: true, usuario: result.rows[0] });
      else res.status(401).json({ error: 'Dados incorretos' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

// ==========================================
//           ROTAS DE ADMINISTRAÇÃO
// ==========================================

// 1. LISTAR TODOS OS USUÁRIOS (Apenas Telefone e Nome para a lista rápida)
app.get('/admin/listar-usuarios', async (req, res) => {
    try {
        const result = await pool.query('SELECT nome_completo as nome, telefone FROM usuarios ORDER BY nome_completo ASC');
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. BUSCAR USUÁRIO MAIS RICO
app.get('/admin/usuario-mais-rico', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome_completo as nome, telefone, saldo_usd FROM usuarios ORDER BY saldo_usd DESC LIMIT 1');
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ error: 'Nenhum usuário encontrado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. BUSCAR USUÁRIO ESPECÍFICO (Atualizado para retornar SENHA)
app.get('/buscar-usuario/:telefone', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome_completo AS nome, saldo_usd, senha, telefone FROM usuarios WHERE telefone = $1', [req.params.telefone]);
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ error: 'Não encontrado' });
    } catch (err) { res.status(500).json({ error: 'Erro no servidor' }); }
});

// 4. ALTERAR SENHA DO USUÁRIO
app.post('/admin/alterar-senha', async (req, res) => {
    const { userId, novaSenha, senhaAdmin } = req.body;
    if (senhaAdmin !== '123') return res.status(401).json({ error: 'Senha admin incorreta' });

    try {
        await pool.query('UPDATE usuarios SET senha = $1 WHERE id = $2', [novaSenha, userId]);
        res.json({ success: true, mensagem: "Senha alterada com sucesso!" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/total-plataforma', async (req, res) => {
    try {
        const result = await pool.query('SELECT SUM(saldo_usd) as total FROM usuarios');
        res.json({ total: result.rows[0].total || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/total-usuarios', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as total FROM usuarios');
        res.json({ total: parseInt(result.rows[0].total) });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
            query = 'UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd, telefone, nome_completo';
        }
        
        const result = await client.query(query, params);

        if (result.rowCount > 0) {
            const { saldo_usd, telefone, nome_completo } = result.rows[0];
            const tipoTransacao = operacao === 'soma' ? 'Depósito' : 'Levantamento';
            const valorRegistro = operacao === 'soma' ? valor : -valor;
            
            await client.query(
                'INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())',
                [userId, tipoTransacao, userId, tipoTransacao, valorRegistro]
            );

            await client.query('COMMIT');

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
            res.status(400).json({ success: false, error: "Saldo insuficiente ou usuário inexistente." });
        }
    } catch (e) { 
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: e.message }); 
    } finally { client.release(); }
});

app.post('/admin/bonus-global', async (req, res) => {
    const { valor } = req.body;
    try {
        const result = await pool.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 RETURNING id, saldo_usd, telefone', [valor]);
        if (result.rows.length > 0) {
            result.rows.forEach((usuario) => {
                const socketDestino = usuariosOnline.get(String(usuario.telefone));
                if (socketDestino) {
                    io.to(socketDestino).emit('atualizar-saldo', {
                        novoSaldo: usuario.saldo_usd,
                        mensagem: `🎁 Você recebeu um bónus de $${valor} do administrador!`
                    });
                }
            });
            res.json({ success: true, usuariosAtualizados: result.rows.length });
        } else { res.status(400).json({ success: false, error: "Nenhum utilizador encontrado." }); }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/eliminar-usuario', async (req, res) => {
    const { userId, senha } = req.body;
    if (senha !== '123') return res.status(401).json({ success: false, error: 'Senha admin incorreta.' });
    
    try {
        await pool.query('DELETE FROM investimentos WHERE user_id = $1', [userId]);
        const deleteUser = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING nome_completo', [userId]);
        if (deleteUser.rowCount > 0) res.json({ success: true, mensagem: "Eliminado." });
        else res.status(404).json({ success: false, error: 'Não encontrado.' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ==========================================
//           TRANSACÇÕES E INVESTIMENTOS
// ==========================================

app.post('/transferir', async (req, res) => {
  const { remetenteTelefone, destinoTelefone, valor } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const remetenteRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [remetenteTelefone]);
    const remetenteId = remetenteRes.rows[0].id;
    const remetenteName = remetenteRes.rows[0].nome_completo;

    const destinatarioRes = await client.query('SELECT id, nome_completo FROM usuarios WHERE telefone = $1', [destinoTelefone]);
    const destinatarioId = destinatarioRes.rows[0].id;
    const destinatarioName = destinatarioRes.rows[0].nome_completo;
    
    const desc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE telefone = $2 AND saldo_usd >= $1 RETURNING saldo_usd', [valor, remetenteTelefone]);
    const inc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE telefone = $2 RETURNING saldo_usd', [valor, destinoTelefone]);
    
    await client.query('INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())', [remetenteId, remetenteName, destinatarioId, destinatarioName, valor]);
    await client.query('COMMIT');

    const socketDestino = usuariosOnline.get(String(destinoTelefone));
    if (socketDestino) io.to(socketDestino).emit('atualizar-saldo', { novoSaldo: inc.rows[0].saldo_usd });

    res.json({ success: true, novoSaldo: desc.rows[0].saldo_usd });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

app.get('/historico/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transacoes WHERE remetente_id = $1 OR destinatario_id = $1 ORDER BY data DESC', [req.params.userId]);
    const transacoes = result.rows.map(t => {
      let titulo = ''; let icon = '📌'; let tipo = '';
      if (t.remetente_nome === 'Investimento') { titulo = `Investimento de $${Math.abs(t.valor).toFixed(2)}`; icon = '💰'; tipo = 'investimento'; }
      else if (t.remetente_nome === 'Ganho do investimento') { titulo = 'Ganho do investimento'; icon = '📈'; tipo = 'ganho'; }
      else if (t.remetente_nome === 'Depósito') { titulo = 'Depósito (Admin)'; icon = '💵'; tipo = 'deposito'; }
      else if (t.remetente_nome === 'Levantamento') { titulo = 'Levantamento (Admin)'; icon = '🏦'; tipo = 'levantamento'; }
      else if (t.remetente_id === parseInt(req.params.userId)) { titulo = `Enviou para ${t.destinatario_nome}`; icon = '📤'; tipo = 'enviado'; }
      else { titulo = `Recebeu de ${t.remetente_nome}`; icon = '📥'; tipo = 'recebido'; }
      return { id: t.id, titulo, tipo, valor: parseFloat(t.valor), data: t.data, icon };
    });
    res.json(transacoes);
  } catch (err) { res.status(500).json({ error: 'Erro no histórico' }); }
});

app.post('/investir', async (req, res) => {
  const { userId, valor, taxa, dias } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const desc = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd - $1 WHERE id = $2 AND saldo_usd >= $1 RETURNING saldo_usd', [valor, userId]);
    if (desc.rowCount === 0) throw new Error('Saldo insuficiente');
    const retorno = valor + (valor * taxa);
    await client.query('INSERT INTO investimentos (user_id, valor_investido_usd, valor_retorno_usd, data_fim) VALUES ($1, $2, $3, CURRENT_DATE + $4 * INTERVAL \'1 day\')', [userId, valor, retorno, dias]);
    await client.query('INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'Sistema', userId, 'Investimento', -valor]);
    await client.query('COMMIT');
    res.json({ success: true, novoSaldo: desc.rows[0].saldo_usd });
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/meus-investimentos/:userId', async (req, res) => {
  try {
    const result = await pool.query("SELECT *, CAST(EXTRACT(DAY FROM (data_fim - CURRENT_DATE)) AS INTEGER) as dias_restantes FROM investimentos WHERE user_id = $1 ORDER BY data_fim DESC", [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

app.post('/resgatar-investimento', async (req, res) => {
  const { investmentId, userId } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const invRes = await client.query('SELECT * FROM investimentos WHERE id = $1 AND user_id = $2', [investmentId, userId]);
    const investimento = invRes.rows[0];
    const dataFimCheck = await client.query('SELECT CURRENT_DATE >= data_fim as venceu FROM investimentos WHERE id = $1', [investmentId]);
    if (!dataFimCheck.rows[0].venceu) throw new Error('Ainda não venceu');
    const saldoRes = await client.query('UPDATE usuarios SET saldo_usd = saldo_usd + $1 WHERE id = $2 RETURNING saldo_usd', [investimento.valor_retorno_usd, userId]);
    await client.query('INSERT INTO transacoes (remetente_id, remetente_nome, destinatario_id, destinatario_nome, valor, data) VALUES ($1, $2, $3, $4, $5, NOW())', [userId, 'Ganho do investimento', userId, 'Ganho do investimento', investimento.valor_retorno_usd]);
    await client.query('DELETE FROM investimentos WHERE id = $1', [investmentId]);
    await client.query('COMMIT');
    res.json({ success: true, novoSaldo: saldoRes.rows[0].saldo_usd });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ success: false, error: e.message }); }
  finally { client.release(); }
});

// --- INICIALIZAÇÃO ---
const PORTA = process.env.PORT || 3000;
server.listen(PORTA, '0.0.0.0', () => {
    console.log(`🚀 API KWANZA NEXUS na Render ativa na porta ${PORTA}`);
});