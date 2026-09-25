const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

const supabase = createClient(
  "https://ohunahxhcjzfrghxvrkf.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "sb_secret_CQVM3JXVzrQ1N8Hg7DUn6w_K0f96YhQ"
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const body = JSON.parse(event.body || '{}');

  try {
    if (body.action === 'login') {
      let { data: player } = await supabase.from('players').select('*').eq('cpf', body.cpf).single();
      if (!player) {
        const { data: newP } = await supabase.from('players').insert({ cpf: body.cpf, balance: 0.00 }).select().single();
        player = newP;
      }
      return { statusCode: 200, body: JSON.stringify({ player }) };
    }

    if (body.action === 'createPix') {
      const txRef = `REC-${Date.now()}`;
      await supabase.from('transactions').insert({ player_id: body.playerId, type: 'DEPOSIT', amount: body.amount, external_ref: txRef, status: 'PENDING' });

      const response = await fetch('https://api.infinitepay.io/v2/checkouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.INFINITEPAY_API_KEY}` },
        body: JSON.stringify({ amount: Math.round(body.amount * 100), metadata: { transaction_ref: txRef, player_id: body.playerId }, payment_methods: ['pix'] })
      });
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify({ pixCode: data.pix_code || data.br_code || data.url }) };
    }

    if (body.action === 'startGame') {
      const { data: player } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
      if (!player || Number(player.balance) < Number(body.betAmount)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Saldo insuficiente! Recarregue via Pix.' }) };
      }
      const positions = Array.from({ length: 12 }, (_, i) => i);
      const bombPositions = [];
      while (bombPositions.length < 3) bombPositions.push(positions.splice(Math.floor(Math.random() * positions.length), 1)[0]);

      const newBal = Number(player.balance) - Number(body.betAmount);
      await supabase.from('players').update({ balance: newBal }).eq('id', body.playerId);
      const { data: game } = await supabase.from('game_sessions').insert({ player_id: body.playerId, bet_amount: body.betAmount, bombs_positions: bombPositions }).select().single();

      return { statusCode: 200, body: JSON.stringify({ gameId: game.id, newBalance: newBal }) };
    }

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
        await supabase.from('transactions').insert({ player_id: body.playerId, type: 'PAYOUT', amount: payout });
      }
      await supabase.from('game_sessions').update({ diamonds_found: diamonds, status }).eq('id', body.gameId);
      return { statusCode: 200, body: JSON.stringify({ result: 'DIAMOND', canCollectHalf: diamonds >= 3, status, newBalance }) };
    }

    if (body.action === 'collectHalf') {
      const { data: game } = await supabase.from('game_sessions').select('*').eq('id', body.gameId).single();
      const payout = game.bet_amount * 0.5;
      const { data: p } = await supabase.from('players').select('balance').eq('id', body.playerId).single();
      const newBal = Number(p.balance) + payout;
      await supabase.from('players').update({ balance: newBal }).eq('id', body.playerId);
      return { statusCode: 200, body: JSON.stringify({ payout, newBalance: newBal }) };
    }

    if (body.action === 'adminStats') {
      if (body.password !== "88778600") return { statusCode: 401, body: JSON.stringify({ error: 'Senha incorreta!' }) };
      const { data: deps } = await supabase.from('transactions').select('amount').eq('type', 'DEPOSIT').eq('status', 'COMPLETED');
      const { data: pays } = await supabase.from('transactions').select('amount').eq('type', 'PAYOUT');
      const totalDeposited = deps?.reduce((a, b) => a + Number(b.amount), 0) || 0;
      const totalPaidOut = pays?.reduce((a, b) => a + Number(b.amount), 0) || 0;
      return { statusCode: 200, body: JSON.stringify({ totalDeposited, totalPaidOut, houseProfit: totalDeposited - totalPaidOut }) };
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
