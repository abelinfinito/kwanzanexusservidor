const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Faltava este
const { exec } = require('child_process'); // Faltava este

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

// --- OUTRAS ROTAS (LOGIN/CADASTRO/BUSCA) ---

app.post('/auth/cadastro', async (req, res) => {
    const { nome, telefone, senha } = req.body;
    try {
      const query = 'INSERT INTO usuarios (nome_completo, telefone, senha, saldo_usd) VALUES ($1, $2, $3, 100) RETURNING *';
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
// --- 1. BUSCA CORRIGIDA (Agora envia ID e Saldo) ---
app.get('/buscar-usuario/:telefone', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome_completo AS nome, saldo_usd FROM usuarios WHERE telefone = $1', [req.params.telefone]);
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
      [req.params.userId]
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
      } else if (t.remetente_id === parseInt(req.params.userId)) {
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
    
    res.json(transacoes);
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

const PORTA = 3000;
server.listen(PORTA, () => {
    console.log(`🚀 KWANZA NEXUS Real-time na porta ${PORTA}`);
    
    const caminhoArquivo = path.join(__dirname, 'index.html');
    const comando = process.platform === 'win32' ? `start "" "${caminhoArquivo}"` : `open "${caminhoArquivo}"`;
    
    exec(comando, (err) => {
        if (!err) console.log("🌐 Interface aberta automaticamente.");
    });
});