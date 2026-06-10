// ═══════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_VALUES = {'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'10':8,'J':9,'Q':10,'K':11,'A':12,'2':13};

// Suit order for tiebreak (spades first)
const SUIT_ORDER = {'♠':0,'♥':1,'♦':2,'♣':3};

function cardValue(rank) { return RANK_VALUES[rank] || 0; }
function isRed(suit) { return suit === '♥' || suit === '♦'; }
function cardKey(c) { return c.rank + c.suit; }

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit });
  return shuffle(deck);
}

function topCard(pile) { return pile.length ? pile[pile.length - 1] : null; }

// ── canPlay ──────────────────────────
function canPlay(cards, pile, mustPlayOnTwo, mustPlayThree) {
  if (!cards.length) return false;
  const rank = cards[0].rank;
  if (!cards.every(c => c.rank === rank)) return false;

  // Opening move: must play a 3
  if (mustPlayThree) {
    return rank === '3';
  }

  // 2 always playable
  if (rank === '2') return true;

  // Playing on top of own 2 — anything goes
  if (mustPlayOnTwo) return true;

  if (!pile.length) return true;

  const top = pile[pile.length - 1];
  if (top.rank === '2') return true;

  let effectiveTop = null;
  for (let i = pile.length - 1; i >= 0; i--) {
    if (pile[i].rank !== '2') { effectiveTop = pile[i]; break; }
  }
  if (!effectiveTop) return true;

  if (effectiveTop.rank === '7') {
    return cardValue(rank) <= cardValue('7');
  }

  return cardValue(rank) >= cardValue(effectiveTop.rank);
}

function checkFourOfAKind(pile) {
  if (pile.length < 4) return false;
  const last = pile[pile.length - 1].rank;
  let count = 0;
  for (let i = pile.length - 1; i >= 0; i--) {
    if (pile[i].rank === last) count++;
    else break;
  }
  return count >= 4;
}

function generateRoomCode() {
  const words = ['WOLF','BEAR','HAWK','DEER','LYNX','CROW','VOLE','PIKE','NEWT','WREN','KITE','FAWN'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 90) + 10;
  return `${w}-${n}`;
}

// Count active (non-disconnected) players
function activePlayerCount() {
  if (!G) return 0;
  return G.players.filter(p => !p.disconnected).length;
}

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let peer = null;
let connections = {};
let hostConn = null;
let isHost = false;
let myPeerId = '';
let myName = '';
let roomCode = '';

let G = null;
let myPlayerIndex = -1;
let selectedCards = [];
let setupSelections = [];

// ═══════════════════════════════════════════════
// PEERJS
// ═══════════════════════════════════════════════
function initPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id, { debug: 0 });
    p.on('open', () => resolve(p));
    p.on('error', err => reject(err));
    peer = p;
  });
}

// ═══════════════════════════════════════════════
// LOBBY ACTIONS
// ═══════════════════════════════════════════════
document.getElementById('btn-host').onclick = async () => {
  myName = document.getElementById('player-name').value.trim();
  if (!myName) { showLobbyError('Enter your name'); return; }
  clearLobbyError();
  roomCode = generateRoomCode();
  const peerId = 'palace-host-' + roomCode.replace('-','');
  try {
    await initPeer(peerId);
  } catch(e) {
    try { await initPeer(peerId + Math.floor(Math.random()*999)); }
    catch(e2) { showLobbyError('Connection failed. Try again.'); return; }
  }
  isHost = true;
  myPeerId = peer.id;
  peer.on('connection', conn => {
    conn.on('open', () => {
      connections[conn.peer] = conn;
      conn.on('data', data => hostReceive(conn.peer, data));
      conn.on('close', () => handleDisconnect(conn.peer));
    });
  });
  showWaitingRoom();
};

document.getElementById('btn-join').onclick = async () => {
  myName = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!myName) { showLobbyError('Enter your name'); return; }
  if (!code) { showLobbyError('Enter a room code'); return; }
  clearLobbyError();
  const hostPeerId = 'palace-host-' + code.replace('-','');
  try {
    await initPeer('palace-' + Date.now() + Math.floor(Math.random()*9999));
  } catch(e) { showLobbyError('Connection failed.'); return; }
  myPeerId = peer.id;
  isHost = false;
  const conn = peer.connect(hostPeerId, { reliable: true });
  hostConn = conn;
  conn.on('open', () => { conn.send({ type: 'join', name: myName, peerId: myPeerId }); });
  conn.on('data', data => clientReceive(data));
  conn.on('error', () => showLobbyError('Could not connect to room.'));
  conn.on('close', () => {
    if (G) {
      toast('Disconnected from host', 'bad');
      showDisconnectBanner('Lost connection to host. The game may continue if others are still connected.');
    } else {
      showLobbyError('Connection closed.');
    }
  });
  setTimeout(() => {
    if (!G && document.getElementById('lobby').style.display !== 'none') {
      showLobbyError('Room not found or timed out.');
    }
  }, 8000);
};

// ═══════════════════════════════════════════════
// DISCONNECT HANDLING (HOST ONLY)
// ═══════════════════════════════════════════════
function handleDisconnect(peerId) {
  delete connections[peerId];

  if (!G) {
    // In waiting room: remove from list
    waitingPlayers = waitingPlayers.filter(p => p.peerId !== peerId);
    broadcast({ type: 'waiting', players: waitingPlayers });
    refreshWaitingRoom();
    return;
  }

  const pi = G.players.findIndex(p => p.peerId === peerId);
  if (pi < 0) return;

  G.players[pi].disconnected = true;
  const dname = G.players[pi].name;
  broadcastToast(`${dname} left the game.`, 'bad');

  // If only 1 active player left in play phase, they win by default
  if (G.phase === 'play' || G.phase === 'setup') {
    const active = G.players.filter(p => !p.disconnected);
    if (active.length === 1) {
      G.phase = 'over';
      G.winner = active[0].index;
      broadcastToast(`${active[0].name} wins — everyone else left!`, 'special');
      broadcastState();
      return;
    }
    if (active.length === 0) {
      // Everyone gone
      broadcastState();
      return;
    }
  }

  // During setup: if disconnected player hasn't done setup, auto-complete their setup
  if (G.phase === 'setup' && !G.players[pi].setupDone) {
    // Auto-assign first 3 hand cards as faceUp
    const p = G.players[pi];
    if (p.hand.length >= 3) {
      p.faceUp = p.hand.slice(0, 3);
      p.hand = p.hand.slice(3);
    } else {
      p.faceUp = [...p.hand];
      p.hand = [];
    }
    p.setupDone = true;
    G.setupCount++;
    checkSetupComplete();
  }

  // During play: if it was their turn, advance
  if (G.phase === 'play' && G.currentPlayer === pi) {
    // Drop their pile-obligation
    G.mustPlayOnTwo = false;
    advanceTurn(pi);
  }

  broadcastState();
}

function checkSetupComplete() {
  if (G.setupCount >= G.players.filter(p => !p.disconnected || p.setupDone).length
    && G.players.every(p => p.setupDone || p.disconnected)) {
    startPlayPhase();
  }
}

// ═══════════════════════════════════════════════
// WAITING ROOM
// ═══════════════════════════════════════════════
let waitingPlayers = [];

function showWaitingRoom() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('waiting-room').style.display = 'flex';
  document.getElementById('room-code-text').textContent = roomCode;
  waitingPlayers = [{ name: myName, peerId: myPeerId, isHost: true }];
  refreshWaitingRoom();
}

function refreshWaitingRoom() {
  document.getElementById('player-count').textContent = waitingPlayers.length;
  const list = document.getElementById('player-list');
  list.innerHTML = waitingPlayers.map(p =>
    `<div class="player-item"><div class="player-dot${p.isHost?' host':''}"></div>${p.name}${p.isHost?' (host)':''}</div>`
  ).join('');
  document.getElementById('btn-start').disabled = waitingPlayers.length < 2;
  document.getElementById('waiting-error').textContent = waitingPlayers.length < 2 ? 'Need at least 2 players' : '';
}

document.getElementById('btn-start').onclick = () => {
  if (waitingPlayers.length < 2) return;
  startGame();
};

function copyRoomCode() {
  navigator.clipboard.writeText(roomCode).then(() => toast('Room code copied!'));
}

// ═══════════════════════════════════════════════
// HOST MESSAGE HANDLING
// ═══════════════════════════════════════════════
function hostReceive(fromPeerId, data) {
  if (data.type === 'join') {
    if (G) { send(fromPeerId, { type: 'error', msg: 'Game already started' }); return; }
    if (waitingPlayers.length >= 6) { send(fromPeerId, { type: 'error', msg: 'Room full' }); return; }
    waitingPlayers.push({ name: data.name, peerId: fromPeerId });
    broadcast({ type: 'waiting', players: waitingPlayers });
    send(fromPeerId, { type: 'joined', roomCode, players: waitingPlayers });
    refreshWaitingRoom();
  } else if (data.type === 'action') {
    if (!G) return;
    processAction(fromPeerId, data.action);
  }
}

function clientReceive(data) {
  if (data.type === 'joined') {
    roomCode = data.roomCode;
    waitingPlayers = data.players;
    document.getElementById('lobby').style.display = 'none';
    showClientWaiting();
  } else if (data.type === 'waiting') {
    waitingPlayers = data.players;
    updateClientWaiting();
  } else if (data.type === 'error') {
    showLobbyError(data.msg);
  } else if (data.type === 'state') {
    applyState(data.state);
  } else if (data.type === 'toast') {
    toast(data.msg, data.style);
  }
}

let clientWaitingShown = false;
function showClientWaiting() {
  clientWaitingShown = true;
  document.getElementById('waiting-room').style.display = 'flex';
  document.getElementById('room-code-text').textContent = '...';
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('room-code-show').style.cursor = 'default';
  refreshClientWaiting();
}
function refreshClientWaiting() {
  document.getElementById('player-count').textContent = waitingPlayers.length;
  const list = document.getElementById('player-list');
  list.innerHTML = waitingPlayers.map(p =>
    `<div class="player-item"><div class="player-dot${p.isHost?' host':''}"></div>${p.name}${p.isHost?' (host)':''}</div>`
  ).join('');
  const st = document.querySelector('#waiting-room p.status-text');
  if (st) st.textContent = 'Waiting for host to start…';
}
function updateClientWaiting() {
  if (!clientWaitingShown) return;
  refreshClientWaiting();
}

// ═══════════════════════════════════════════════
// NETWORK HELPERS
// ═══════════════════════════════════════════════
function send(peerId, data) {
  const conn = connections[peerId];
  if (conn && conn.open) conn.send(data);
}
function broadcast(data) {
  Object.values(connections).forEach(conn => { if (conn.open) conn.send(data); });
}
function sendToHost(action) {
  if (isHost) {
    processAction(myPeerId, action);
  } else if (hostConn && hostConn.open) {
    hostConn.send({ type: 'action', action });
  }
}
function broadcastState() {
  const stateForBroadcast = JSON.parse(JSON.stringify(G));
  broadcast({ type: 'state', state: stateForBroadcast });
  applyState(stateForBroadcast);
}
function broadcastToast(msg, style) {
  broadcast({ type: 'toast', msg, style });
  toast(msg, style);
}

// ═══════════════════════════════════════════════
// GAME INIT (HOST ONLY)
// ═══════════════════════════════════════════════
function startGame() {
  const deck = makeDeck();
  const players = waitingPlayers.map((p, i) => ({
    index: i,
    name: p.name,
    peerId: p.peerId,
    hand: [],
    faceUp: [],
    faceDown: [],
    setupDone: false,
    disconnected: false,
  }));

  for (const player of players) {
    player.faceDown = [deck.pop(), deck.pop(), deck.pop()];
    player.hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  }

  G = {
    phase: 'setup',
    players,
    drawPile: deck,
    playPile: [],
    discard: [],
    currentPlayer: 0,
    setupCount: 0,
    mustPlayOnTwo: false,
    mustPlayThree: false,
    openingPlayer: -1, // set after setup
  };

  myPlayerIndex = G.players.findIndex(p => p.peerId === myPeerId);
  broadcastState();
}

// ── Find who starts: player with 3♠ first, else lowest 3 ──
function findOpeningPlayer() {
  // Check hand + faceUp cards for each player
  for (const player of G.players) {
    if (player.disconnected) continue;
    const allCards = [...player.hand, ...player.faceUp];
    if (allCards.some(c => c.rank === '3' && c.suit === '♠')) {
      return player.index;
    }
  }
  // Fallback: any 3, prioritised by suit order ♠♥♦♣
  for (const suit of ['♠','♥','♦','♣']) {
    for (const player of G.players) {
      if (player.disconnected) continue;
      const allCards = [...player.hand, ...player.faceUp];
      if (allCards.some(c => c.rank === '3' && c.suit === suit)) {
        return player.index;
      }
    }
  }
  // Edge case: no 3s visible (all in faceDown) — just start with player 0
  return G.players.findIndex(p => !p.disconnected);
}

function startPlayPhase() {
  G.phase = 'play';
  G.openingPlayer = findOpeningPlayer();
  G.currentPlayer = G.openingPlayer;
  G.mustPlayThree = true;
  const starter = G.players[G.openingPlayer];
  broadcastToast(`Game on! ${starter.name} opens with a 3.`, 'good');
}

// ═══════════════════════════════════════════════
// GAME ACTIONS
// ═══════════════════════════════════════════════
function processAction(fromPeerId, action) {
  const pi = G.players.findIndex(p => p.peerId === fromPeerId);
  if (pi < 0) return;
  const player = G.players[pi];

  if (action.type === 'setup_done') {
    if (G.phase !== 'setup' || player.setupDone) return;
    const chosen = action.faceUp;
    if (chosen.length !== 3) return;
    const handKeys = player.hand.map(cardKey);
    if (!chosen.every(c => handKeys.includes(cardKey(c)))) return;
    player.faceUp = chosen;
    const chosenKeys = chosen.map(cardKey);
    player.hand = player.hand.filter(c => !chosenKeys.includes(cardKey(c)));
    player.setupDone = true;
    G.setupCount++;
    // Check if all active players are done
    const activePlayers = G.players.filter(p => !p.disconnected);
    if (activePlayers.every(p => p.setupDone)) {
      startPlayPhase();
    }
    broadcastState();
    return;
  }

  if (action.type === 'play') {
    if (G.phase !== 'play') return;
    if (G.currentPlayer !== pi) return;
    const cards = action.cards;
    const source = getPlayableSource(player);
    if (!source) return;
    if (!cards.length || !cards.every(c => c.rank === cards[0].rank)) return;

    const isBlind = source === 'faceDown';

    if (isBlind) {
      if (cards.length !== 1) return;
      const c = cards[0];
      if (!player.faceDown.some(fd => fd.rank === c.rank && fd.suit === c.suit)) return;
      // mustPlayThree can't happen from faceDown (opening move always from hand/faceUp)
      if (!canPlay([c], G.playPile, false, false)) {
        player.faceDown = player.faceDown.filter(fd => !(fd.rank === c.rank && fd.suit === c.suit));
        G.playPile.push(c);
        broadcastToast(`${player.name} flipped ${c.rank}${c.suit} — picks up the pile!`, 'bad');
        player.hand = player.hand.concat(G.playPile);
        G.playPile = [];
        G.mustPlayOnTwo = false;
        advanceTurn(pi);
        broadcastState();
        return;
      }
      player.faceDown = player.faceDown.filter(fd => !(fd.rank === c.rank && fd.suit === c.suit));
      afterPlay(pi, [c]);

    } else if (source === 'faceUp') {
      if (cards.length !== 1) return;
      const c = cards[0];
      if (!player.faceUp.some(fu => fu.rank === c.rank && fu.suit === c.suit)) return;
      if (!canPlay([c], G.playPile, G.mustPlayOnTwo, G.mustPlayThree)) return;
      player.faceUp = player.faceUp.filter(fu => !(fu.rank === c.rank && fu.suit === c.suit));
      G.mustPlayThree = false;
      afterPlay(pi, [c]);

    } else {
      // hand
      const poolKeys = player.hand.map(cardKey);
      if (!cards.every(c => poolKeys.includes(cardKey(c)))) return;
      if (!canPlay(cards, G.playPile, G.mustPlayOnTwo, G.mustPlayThree)) return;
      const playedKeys = cards.map(cardKey);
      player.hand = player.hand.filter(c => !playedKeys.includes(cardKey(c)));
      G.mustPlayThree = false;
      afterPlay(pi, cards);
    }
  }

  if (action.type === 'pickup') {
    if (G.phase !== 'play') return;
    if (G.currentPlayer !== pi) return;
    if (G.mustPlayThree) return; // can't pick up on opening move
    if (!G.playPile.length) return;
    player.hand = player.hand.concat(G.playPile);
    G.playPile = [];
    G.mustPlayOnTwo = false;
    broadcastToast(`${player.name} picked up the pile.`, 'bad');
    advanceTurn(pi);
    broadcastState();
  }
}

function afterPlay(pi, cards) {
  const player = G.players[pi];
  const rank = cards[0].rank;
  G.playPile.push(...cards);

  if (rank === '10') {
    G.discard.push(...G.playPile);
    G.playPile = [];
    G.mustPlayOnTwo = false;
    refillHand(player);
    broadcastToast(`${player.name} played a 10 — NUKE! Pile cleared. Play again.`, 'special');
    if (!checkWin(pi)) broadcastState();
    return;
  }

  if (checkFourOfAKind(G.playPile)) {
    G.discard.push(...G.playPile);
    G.playPile = [];
    G.mustPlayOnTwo = false;
    refillHand(player);
    broadcastToast(`Four of a kind! Pile cleared — ${player.name} goes again.`, 'special');
    if (!checkWin(pi)) broadcastState();
    return;
  }

  if (rank === '2') {
    refillHand(player);
    G.mustPlayOnTwo = true;
    broadcastToast(`${player.name} played a 2 — must play on top of it!`, 'special');
    if (!checkWin(pi)) broadcastState();
    return;
  }

  G.mustPlayOnTwo = false;
  refillHand(player);
  if (!checkWin(pi)) {
    advanceTurn(pi);
    broadcastState();
  }
}

function refillHand(player) {
  while (player.hand.length < 3 && G.drawPile.length > 0) {
    player.hand.push(G.drawPile.pop());
  }
}

function advanceTurn(pi) {
  let next = (pi + 1) % G.players.length;
  let tries = 0;
  while (G.players[next].disconnected && tries < G.players.length) {
    next = (next + 1) % G.players.length;
    tries++;
  }
  G.currentPlayer = next;
}

function checkWin(pi) {
  const player = G.players[pi];
  if (player.hand.length === 0 && player.faceUp.length === 0 && player.faceDown.length === 0) {
    G.phase = 'over';
    G.winner = pi;
    G.mustPlayOnTwo = false;
    G.mustPlayThree = false;
    broadcastToast(`🏆 ${player.name} wins!`, 'special');
    broadcastState();
    return true;
  }
  return false;
}

function getPlayableSource(player) {
  if (player.hand.length > 0) return 'hand';
  if (player.faceUp.length > 0) return 'faceUp';
  if (player.faceDown.length > 0) return 'faceDown';
  return null;
}

// ═══════════════════════════════════════════════
// APPLY STATE + RENDER
// ═══════════════════════════════════════════════
function applyState(state) {
  G = state;
  if (myPlayerIndex < 0) {
    myPlayerIndex = G.players.findIndex(p => p.peerId === myPeerId);
  }
  showGame();
}

function showGame() {
  document.getElementById('waiting-room').style.display = 'none';
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'flex';
  if (G) renderGame();
}

function renderGame() {
  if (!G) return;
  const me = G.players[myPlayerIndex];
  if (!me) return;

  const isMyTurn = G.phase === 'play' && G.currentPlayer === myPlayerIndex;

  // ── Disconnect banner ──
  const discBanner = document.getElementById('disconnect-banner');
  const disconnected = G.players.filter(p => p.disconnected);
  if (disconnected.length > 0 && G.phase !== 'over') {
    discBanner.style.display = 'block';
    discBanner.textContent = disconnected.map(p => p.name).join(', ') + ' left — their turn' + (disconnected.length > 1 ? 's are' : ' is') + ' skipped.';
  } else {
    discBanner.style.display = 'none';
  }

  // ── Turn indicator ──
  const turnEl = document.getElementById('turn-indicator');
  turnEl.className = 'turn-indicator';
  if (G.phase === 'setup') {
    turnEl.textContent = me.setupDone ? 'Waiting…' : 'Pick face-up cards';
  } else if (G.phase === 'over') {
    const winnerName = G.players[G.winner]?.name;
    turnEl.textContent = G.winner === myPlayerIndex ? '🏆 You Win!' : `${winnerName} Wins!`;
    if (G.winner === myPlayerIndex) turnEl.classList.add('my-turn');
    showWinnerModal(G.winner);
  } else {
    const cur = G.players[G.currentPlayer];
    if (isMyTurn && G.mustPlayOnTwo) {
      turnEl.textContent = 'Play on your 2 ▶';
      turnEl.classList.add('my-turn-two');
    } else if (isMyTurn && G.mustPlayThree) {
      turnEl.textContent = 'Play your 3 ▶';
      turnEl.classList.add('must-play-3');
    } else if (isMyTurn) {
      turnEl.textContent = 'Your Turn ▶';
      turnEl.classList.add('my-turn');
    } else {
      turnEl.textContent = `${cur.name}'s Turn`;
    }
  }

  // ── Opponents ──
  const oppZone = document.getElementById('opponents-zone');
  oppZone.innerHTML = '';
  const total = G.players.length;
  for (let offset = 1; offset < total; offset++) {
    const i = (myPlayerIndex + offset) % total;
    const p = G.players[i];
    const isActive = G.currentPlayer === i && G.phase === 'play';
    const div = document.createElement('div');
    div.className = 'opponent-area' + (isActive ? ' active-opp' : '') + (p.disconnected ? ' disconnected-opp' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'opponent-name' + (isActive ? ' active-player' : '');
    nameEl.textContent = p.name + (p.disconnected ? ' ✕' : '');
    if (isActive && !p.disconnected) {
      const arrow = document.createElement('span');
      arrow.className = 'turn-arrow';
      arrow.textContent = ' ▶';
      nameEl.appendChild(arrow);
    }
    div.appendChild(nameEl);

    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'opponent-cards';
    p.faceDown.forEach(() => cardsDiv.appendChild(makeSmallCardEl({ faceDown: true })));
    p.faceUp.forEach(c => cardsDiv.appendChild(makeSmallCardEl(c)));
    div.appendChild(cardsDiv);

    if (p.hand.length > 0) {
      const badge = document.createElement('div');
      badge.className = 'hand-count-badge';
      badge.textContent = `${p.hand.length} in hand`;
      div.appendChild(badge);
    } else if (!p.faceDown.length && !p.faceUp.length && !p.disconnected) {
      const badge = document.createElement('div');
      badge.className = 'hand-count-badge empty';
      badge.textContent = 'No cards!';
      div.appendChild(badge);
    }
    oppZone.appendChild(div);
  }

  // ── Draw pile ──
  const drawVis = document.getElementById('draw-pile-visual');
  drawVis.innerHTML = '';
  if (G.drawPile.length > 0) {
    const stack = document.createElement('div');
    stack.className = 'card-pile-stack';
    const n = Math.min(3, G.drawPile.length);
    for (let i = 0; i < n; i++) stack.appendChild(makeCardEl({ faceDown: true }));
    drawVis.appendChild(stack);
  } else {
    const empty = document.createElement('div');
    empty.className = 'discard-empty';
    empty.textContent = '∅';
    drawVis.appendChild(empty);
  }
  document.getElementById('deck-count').textContent = G.drawPile.length + ' left';

  // ── Play pile & discard piles ──
  renderPileSpread('play-pile-visual', G.playPile, 'pile-top-label');
  renderPileSpread('discard-pile-visual', G.discard, 'discard-top-label');

  // ── My area glow ──
  document.getElementById('my-name-label').textContent = me.name + ' (you)';
  const myAreaEl = document.getElementById('my-area');
  myAreaEl.className = 'my-area';
  if (isMyTurn && G.mustPlayOnTwo) myAreaEl.classList.add('must-play-two');
  else if (isMyTurn && G.mustPlayThree) myAreaEl.classList.add('must-play-3-border');
  else if (isMyTurn) myAreaEl.classList.add('active-turn');

  renderMyFaceDown(me);
  renderMyFaceUp(me);
  renderMyHand(me);

  const setupInstr = document.getElementById('setup-instructions');
  if (G.phase === 'setup' && !me.setupDone) {
    setupInstr.style.display = 'block';
    setupInstr.textContent = `Select 3 cards to place face-up on your palace (${setupSelections.length}/3)`;
  } else {
    setupInstr.style.display = 'none';
  }

  // ── Action buttons ──
  const playBtn = document.getElementById('btn-play');
  const pickupBtn = document.getElementById('btn-pickup');

  if (G.phase === 'setup' && !me.setupDone) {
    playBtn.textContent = `Confirm Face-Up (${setupSelections.length}/3)`;
    playBtn.disabled = setupSelections.length !== 3;
    pickupBtn.disabled = true;
    pickupBtn.style.display = 'none';
  } else if (G.phase === 'play' && isMyTurn) {
    pickupBtn.style.display = '';
    const source = getPlayableSource(me);
    if (source === 'faceDown') {
      playBtn.textContent = 'Flip Face-Down Card';
      playBtn.disabled = selectedCards.length !== 1;
    } else {
      const valid = selectedCards.length > 0 && canPlay(selectedCards, G.playPile, G.mustPlayOnTwo, G.mustPlayThree);
      if (G.mustPlayThree) {
        playBtn.textContent = selectedCards.length ? 'Play your 3' : 'Select your 3 to play';
      } else if (G.mustPlayOnTwo) {
        playBtn.textContent = selectedCards.length ? `Play ${selectedCards.length} on your 2` : 'Play on your 2';
      } else {
        playBtn.textContent = selectedCards.length
          ? `Play ${selectedCards.length} Card${selectedCards.length > 1 ? 's' : ''}`
          : 'Select cards to play';
      }
      playBtn.disabled = !valid;
    }
    pickupBtn.disabled = G.playPile.length === 0 || !!G.mustPlayOnTwo || !!G.mustPlayThree;
    pickupBtn.textContent = (G.mustPlayOnTwo || G.mustPlayThree)
      ? 'Cannot pick up'
      : `Pick Up (${G.playPile.length})`;
  } else {
    playBtn.disabled = true;
    playBtn.textContent = G.phase === 'setup' ? 'Waiting…' : 'Play';
    pickupBtn.disabled = true;
    pickupBtn.style.display = G.phase === 'setup' ? 'none' : '';
  }
}

// ── Horizontal spread renderer ────────────────────────────────────────────
function renderPileSpread(containerId, pile, labelId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (!pile || pile.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'discard-empty';
    empty.textContent = '♠';
    container.appendChild(empty);
    if (labelId) document.getElementById(labelId).textContent = 'Empty';
    return;
  }

  // Use CSS variable for card size (reads computed value)
  const cardW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 68;
  const cardH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-h')) || 96;
  const MAX_SHOW = 5;
  const PEEK = Math.round(cardW * 0.32); // ~22px on desktop, ~17px on mobile

  const startIdx = Math.max(0, pile.length - MAX_SHOW);
  const visible = pile.slice(startIdx);
  const count = visible.length;
  const totalW = PEEK * (count - 1) + cardW;

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.width = totalW + 'px';
  wrap.style.height = cardH + 'px';

  visible.forEach((c, i) => {
    const isTop = i === count - 1;
    const card = makeCardEl(c);
    card.style.position = 'absolute';
    card.style.left = (i * PEEK) + 'px';
    card.style.top = '0';
    card.style.zIndex = i + 1;
    if (!isTop) {
      card.style.clipPath = `inset(0 ${cardW - PEEK}px 0 0)`;
    }
    wrap.appendChild(card);
  });

  container.appendChild(wrap);

  if (labelId) {
    const top = pile[pile.length - 1];
    document.getElementById(labelId).textContent =
      `${top.rank}${top.suit} · ${pile.length}`;
  }
}

function renderMyFaceDown(me) {
  const el = document.getElementById('my-palace-face-down');
  el.innerHTML = '';
  me.faceDown.forEach((c) => {
    const slot = document.createElement('div');
    slot.className = 'palace-slot';
    const card = makeCardEl({ faceDown: true });
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'faceDown') {
      card.classList.add('selectable');
      if (selectedCards.some(s => s.rank === c.rank && s.suit === c.suit)) card.classList.add('selected');
      card.onclick = () => toggleSelectFaceDown(c);
    }
    slot.appendChild(card);
    el.appendChild(slot);
  });
}

function renderMyFaceUp(me) {
  const el = document.getElementById('my-palace-face-up');
  el.innerHTML = '';
  if (G.phase === 'setup' && !me.setupDone) return;
  me.faceUp.forEach(c => {
    const slot = document.createElement('div');
    slot.className = 'palace-slot';
    const card = makeCardEl(c);
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'faceUp') {
      card.classList.add('selectable');
      if (selectedCards.some(s => s.rank === c.rank && s.suit === c.suit)) card.classList.add('selected');
      card.onclick = () => toggleSelectFaceUp(c);
    }
    slot.appendChild(card);
    el.appendChild(slot);
  });
}

function renderMyHand(me) {
  const el = document.getElementById('my-hand');
  el.innerHTML = '';

  if (G.phase === 'setup' && !me.setupDone) {
    const sorted = [...me.hand].sort((a, b) => cardValue(a.rank) - cardValue(b.rank));
    sorted.forEach(c => {
      const card = makeCardEl(c);
      card.classList.add('selectable');
      if (setupSelections.some(s => s.rank === c.rank && s.suit === c.suit)) card.classList.add('selected');
      card.onclick = () => toggleSetupSelect(c);
      el.appendChild(card);
    });
    return;
  }

  const sorted = [...me.hand].sort((a, b) => cardValue(a.rank) - cardValue(b.rank));
  sorted.forEach(c => {
    const card = makeCardEl(c);
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'hand') {
      card.classList.add('selectable');
      if (selectedCards.some(s => s.rank === c.rank && s.suit === c.suit)) card.classList.add('selected');
      card.onclick = () => toggleSelect(c);
    }
    el.appendChild(card);
  });
}

// ═══════════════════════════════════════════════
// CARD ELEMENT BUILDERS
// ═══════════════════════════════════════════════
function makeCardEl(c) {
  const el = document.createElement('div');
  el.className = 'card';
  if (c.faceDown) { el.classList.add('face-down'); return el; }
  el.classList.add(isRed(c.suit) ? 'red' : 'black');
  if (c.rank === '2') el.classList.add('special-2');
  if (c.rank === '7') el.classList.add('special-7');
  if (c.rank === '10') el.classList.add('special-10');
  el.innerHTML = `
    <div class="card-corner"><span>${c.rank}</span><span class="suit-small">${c.suit}</span></div>
    <span class="card-center-suit">${c.suit}</span>
    <div class="card-corner-bottom"><span>${c.rank}</span><span class="suit-small">${c.suit}</span></div>
  `;
  return el;
}

function makeSmallCardEl(c) {
  const el = document.createElement('div');
  el.className = 'card-sm';
  if (c.faceDown) { el.classList.add('face-down'); return el; }
  el.classList.add(isRed(c.suit) ? 'red' : 'black');
  el.innerHTML = `<span class="card-sm-rank">${c.rank}</span><span class="card-sm-suit">${c.suit}</span>`;
  return el;
}

// ═══════════════════════════════════════════════
// CARD SELECTION
// ═══════════════════════════════════════════════
function toggleSelect(c) {
  const idx = selectedCards.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  if (idx >= 0) {
    selectedCards.splice(idx, 1);
  } else {
    if (selectedCards.length > 0 && selectedCards[0].rank !== c.rank) {
      selectedCards = [c];
    } else {
      selectedCards.push(c);
    }
  }
  renderGame();
}

function toggleSelectFaceUp(c) {
  const idx = selectedCards.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  selectedCards = idx >= 0 ? [] : [c];
  renderGame();
}

function toggleSelectFaceDown(c) {
  const idx = selectedCards.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  selectedCards = idx >= 0 ? [] : [c];
  renderGame();
}

function toggleSetupSelect(c) {
  const idx = setupSelections.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  if (idx >= 0) {
    setupSelections.splice(idx, 1);
  } else if (setupSelections.length < 3) {
    setupSelections.push(c);
  }
  renderGame();
}

// ═══════════════════════════════════════════════
// PLAY / PICKUP BUTTONS
// ═══════════════════════════════════════════════
document.getElementById('btn-play').onclick = () => {
  if (!G) return;
  if (G.phase === 'setup') {
    if (setupSelections.length !== 3) return;
    sendToHost({ type: 'setup_done', faceUp: setupSelections });
    setupSelections = [];
    return;
  }
  if (G.phase === 'play') {
    const me = G.players[myPlayerIndex];
    const source = getPlayableSource(me);
    if ((source === 'faceDown' && selectedCards.length === 1) ||
        (source !== 'faceDown' && selectedCards.length > 0)) {
      sendToHost({ type: 'play', cards: selectedCards });
    }
    selectedCards = [];
    renderGame();
  }
};

document.getElementById('btn-pickup').onclick = () => {
  if (!G || G.phase !== 'play') return;
  sendToHost({ type: 'pickup' });
  selectedCards = [];
};

// ═══════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════
function toast(msg, style = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (style ? ' ' + style : '');
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function showLobbyError(msg) { document.getElementById('lobby-error').textContent = msg; }
function clearLobbyError() { document.getElementById('lobby-error').textContent = ''; }

function showDisconnectBanner(msg) {
  const b = document.getElementById('disconnect-banner');
  if (b) { b.style.display = 'block'; b.textContent = msg; }
}

function showWinnerModal(winnerIdx) {
  if (!G) return;
  const modal = document.getElementById('winner-modal');
  if (modal.style.display === 'flex') return;
  modal.style.display = 'flex';
  const winner = G.players[winnerIdx];
  document.getElementById('winner-title').textContent =
    winnerIdx === myPlayerIndex ? '🏆 You Win!' : `${winner.name} Wins!`;
  document.getElementById('winner-msg').textContent = winnerIdx === myPlayerIndex
    ? 'Congratulations! You cleared all your cards first.'
    : `${winner.name} emptied all their cards first.`;
}

function closeRules() {
  document.getElementById('rules-modal').style.display = 'none';
}

// Rules accessible from both lobby and in-game
document.getElementById('btn-rules').onclick = () => {
  document.getElementById('rules-modal').style.display = 'flex';
};
document.getElementById('btn-rules-ingame').onclick = () => {
  document.getElementById('rules-modal').style.display = 'flex';
};
// Close modal on overlay click
document.getElementById('rules-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeRules();
});
document.getElementById('winner-modal').addEventListener('click', e => { /* don't close on tap outside */ });

// Keyboard
document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-host').click();
});
document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});
document.getElementById('room-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});