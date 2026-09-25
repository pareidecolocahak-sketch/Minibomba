const { createClient } = require('@supabase/supabase-js');

// Puxa a chave diretamente das variáveis de ambiente salvas no Netlify
const supabase = createClient(
  "https://ohunahxhcjzfrghxvrkf.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const body = JSON.parse(event.body || '{}');

  try {
    // LOGIN CPF
    if (body.action === 'login') {
      let { data: player } = await supabase.from('players').select('*').eq('cpf', body.cpf).single();
      if (!player) {
        const { data: newP } = await supabase.from('players').insert({ cpf: body.cpf, balance: 0.00 }).select().single();
        player = newP;
      }
      return { statusCode: 200, body: JSON.stringify({ player }) };
    }

    // INICIAR JOGO
    if (body.action === 'startGame') {
      const { data: player } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
      if (!player || Number(player.balance) < Number(body.betAmount)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Saldo insuficiente! Faça um depósito.' }) };
      }
      const positions = Array.from({ length: 12 }, (_, i) => i);
      const bombPositions = [];
      while (bombPositions.length < 3) bombPositions.push(positions.splice(Math.floor(Math.random() * positions.length), 1)[0]);

      const newBal = Number(player.balance) - Number(body.betAmount);
      await supabase.from('players').update({ balance: newBal }).eq('id', body.playerId);
      const { data: game } = await supabase.from('game_sessions').insert({ player_id: body.playerId, bet_amount: body.betAmount, bombs_positions: bombPositions }).select().single();

      return { statusCode: 200, body: JSON.stringify({ gameId: game.id, newBalance: newBal }) };
    }

    // ABRIR QUADRADO
    if (body.action === 'revealTile') {
      const { data: game } = await supabase.from('game_sessions').select('*').eq('id', body.gameId).single();
      if (game.bombs_positions.includes(body.tileIndex)) {
        await supabase.from('game_sessions').update({ status: 'BOOM' }).eq('id', body.gameId);
        return { statusCode: 200, body: JSON.stringify({ result: 'BOOM' }) };
      }
      const diamonds = game.diamonds_found + 1;
      let newBalance = 0, status = 'ACTIVE';
      if (diamonds === 4) {
        status = 'WON_100';
        const payout = game.bet_amount * 2;
        const { data: p } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
        newBalance = Number(p.balance) + payout;
        await supabase.from('players').update({ balance: newBalance }).eq('id', body.playerId);
        await supabase.from('transactions').insert({ player_id: body.playerId, type: 'PAYOUT', amount: payout, status: 'COMPLETED' });
      }
      await supabase.from('game_sessions').update({ diamonds_found: diamonds, status }).eq('id', body.gameId);
      return { statusCode: 200, body: JSON.stringify({ result: 'DIAMOND', canCollectHalf: diamonds >= 3, status, newBalance }) };
    }

    // COLETAR METADE (50%)
    if (body.action === 'collectHalf') {
      const { data: game } = await supabase.from('game_sessions').select('*').eq('id', body.gameId).single();
      const payout = game.bet_amount * 0.5;
      const { data: p } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
      const newBal = Number(p.balance) + payout;
      await supabase.from('players').update({ balance: newBal }).eq('id', body.playerId);
      return { statusCode: 200, body: JSON.stringify({ payout, newBalance: newBal }) };
    }

    // CLIENTE SOLICITAR SAQUE
    if (body.action === 'requestWithdraw') {
      const { data: player } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
      if (!player || Number(player.balance) < Number(body.amount)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Saldo insuficiente para este saque!' }) };
      }
      const newBal = Number(player.balance) - Number(body.amount);
      await supabase.from('players').update({ balance: newBal }).eq('id', body.playerId);
      
      await supabase.from('transactions').insert({
        player_id: body.playerId,
        type: 'WITHDRAW',
        amount: body.amount,
        external_ref: body.pixKey,
        status: 'PENDING'
      });

      return { statusCode: 200, body: JSON.stringify({ success: true, newBalance: newBal }) };
    }

    // PAINEL DO DONO - ESTATÍSTICAS E LISTA DE SAQUES
    if (body.action === 'adminStats') {
      if (body.password !== "88778600") return { statusCode: 401, body: JSON.stringify({ error: 'Senha incorreta!' }) };
      const { data: deps } = await supabase.from('transactions').select('amount').eq('type', 'DEPOSIT').eq('status', 'COMPLETED');
      const { data: pays } = await supabase.from('transactions').select('amount').eq('type', 'COMPLETED').or('type.eq.PAYOUT,type.eq.WITHDRAW');
      const { data: pending } = await supabase.from('transactions').select('*, players(cpf)').eq('type', 'WITHDRAW').eq('status', 'PENDING');

      const totalDeposited = deps?.reduce((a, b) => a + Number(b.amount), 0) || 0;
      const totalPaidOut = pays?.reduce((a, b) => a + Number(b.amount), 0) || 0;
      return { statusCode: 200, body: JSON.stringify({ totalDeposited, totalPaidOut, houseProfit: totalDeposited - totalPaidOut, pendingWithdraws: pending || [] }) };
    }

    // PAINEL DO DONO - ADICIONAR SALDO DEPOSITO
    if (body.action === 'adminAddBalance') {
      if (body.password !== "88778600") return { statusCode: 401, body: JSON.stringify({ error: 'Senha incorreta!' }) };
      const { data: player } = await supabase.from('players').select('*').eq('cpf', body.cpf).single();
      if (!player) return { statusCode: 404, body: JSON.stringify({ error: 'Jogador não encontrado' }) };

      const newBal = Number(player.balance) + Number(body.amount);
      await supabase.from('players').update({ balance: newBal }).eq('id', player.id);
      await supabase.from('transactions').insert({ player_id: player.id, type: 'DEPOSIT', amount: body.amount, status: 'COMPLETED' });

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // PAINEL DO DONO - PROCESSAR SAQUE (APROVAR/RECUSAR)
    if (body.action === 'adminProcessWithdraw') {
      if (body.password !== "88778600") return { statusCode: 401, body: JSON.stringify({ error: 'Senha incorreta!' }) };
      const { data: tx } = await supabase.from('transactions').select('*').eq('id', body.txId).single();

      if (body.decision === 'APPROVE') {
        await supabase.from('transactions').update({ status: 'COMPLETED' }).eq('id', body.txId);
      } else if (body.decision === 'REJECT_REFUND') {
        await supabase.from('transactions').update({ status: 'REJECTED' }).eq('id', body.txId);
        const { data: player } = await supabase.from('players').select('balance').eq('id', tx.player_id).single();
        await supabase.from('players').update({ balance: Number(player.balance) + Number(tx.amount) }).eq('id', tx.player_id);
      } else if (body.decision === 'REJECT_NO_REFUND') {
        await supabase.from('transactions').update({ status: 'REJECTED' }).eq('id', body.txId);
      }

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
