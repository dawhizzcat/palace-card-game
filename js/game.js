// ═══════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const RANK_VALUES = {'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'10':8,'J':9,'Q':10,'K':11,'A':12,'2':13};

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

function effectiveTop(pile) {
  // The effective top for comparison, ignoring 2s
  for (let i = pile.length - 1; i >= 0; i--) {
    if (pile[i].rank !== '2') return pile[i];
  }
  return null;
}

function canPlay(cards, pile) {
  if (!cards.length) return false;
  const rank = cards[0].rank;
  // All selected cards must be same rank
  if (!cards.every(c => c.rank === rank)) return false;
  // 2 and 10 can always be played
  if (rank === '2' || rank === '10') return true;
  const top = effectiveTop(pile);
  if (!top) return true; // empty pile
  // If last non-2 card was a 7, must play 7 or lower
  if (top.rank === '7') {
    return cardValue(rank) <= cardValue('7');
  }
  return cardValue(rank) >= cardValue(top.rank);
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

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let peer = null;
let connections = {}; // peerId -> conn (host only)
let hostConn = null;  // client -> host connection
let isHost = false;
let myPeerId = '';
let myName = '';
let roomCode = '';

// Full game state (host maintains this, clients get synced copy)
let G = null;
let myPlayerIndex = -1;
let selectedCards = [];
let setupSelections = []; // during setup phase

// ═══════════════════════════════════════════════
// PEERJS SETUP
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
    // PeerJS id might conflict, try alternate
    try { await initPeer(peerId + Math.floor(Math.random()*999)); }
    catch(e2) { showLobbyError('Connection failed. Try again.'); return; }
  }

  isHost = true;
  myPeerId = peer.id;

  // Listen for incoming connections
  peer.on('connection', conn => {
    conn.on('open', () => {
      connections[conn.peer] = conn;
      conn.on('data', data => hostReceive(conn.peer, data));
      conn.on('close', () => {
        delete connections[conn.peer];
        if (G) {
          // Mark player as disconnected
          const pi = G.players.findIndex(p => p.peerId === conn.peer);
          if (pi >= 0) G.players[pi].disconnected = true;
          broadcastState();
        } else {
          refreshWaitingRoom();
        }
      });
    });
  });

  // Show waiting room
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
  } catch(e) {
    showLobbyError('Connection failed.'); return;
  }

  myPeerId = peer.id;
  isHost = false;

  const conn = peer.connect(hostPeerId, { reliable: true });
  hostConn = conn;

  conn.on('open', () => {
    conn.send({ type: 'join', name: myName, peerId: myPeerId });
  });

  conn.on('data', data => clientReceive(data));
  conn.on('error', () => showLobbyError('Could not connect to room.'));
  conn.on('close', () => {
    if (G) toast('Disconnected from host', 'bad');
    else showLobbyError('Connection closed.');
  });

  // Timeout
  setTimeout(() => {
    if (!G && document.getElementById('lobby').style.display !== 'none') {
      showLobbyError('Room not found or timed out.');
    }
  }, 8000);
};

// ═══════════════════════════════════════════════
// WAITING ROOM
// ═══════════════════════════════════════════════
let waitingPlayers = []; // [{name, peerId}]

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
    // Tell everyone the updated list
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
    // Show a simple waiting message
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
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('waiting-room').style.display = 'flex';
  document.getElementById('room-code-text').textContent = '...';
  // Hide start button for clients
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
  document.querySelector('#waiting-room p.status-text').textContent = 'Waiting for host to start…';
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
  // Send full state to all clients
  const stateForBroadcast = JSON.parse(JSON.stringify(G));
  broadcast({ type: 'state', state: stateForBroadcast });
  // Apply locally for host
  applyState(stateForBroadcast);
}

function broadcastToast(msg, style) {
  broadcast({ type: 'toast', msg, style });
  toast(msg, style);
}

// ═══════════════════════════════════════════════
// GAME INITIALIZATION (HOST ONLY)
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

  // Deal: 3 face-down, 6 to hand (player picks 3 for face-up from their hand)
  for (const player of players) {
    player.faceDown = [deck.pop(), deck.pop(), deck.pop()];
    player.hand = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];
  }

  G = {
    phase: 'setup',      // setup | play | over
    players,
    drawPile: deck,
    playPile: [],
    discard: [],
    currentPlayer: 0,
    setupCount: 0,       // how many have finished setup
    mustPlayOnTwo: false,
    direction: 1,
  };

  // Host's index
  myPlayerIndex = G.players.findIndex(p => p.peerId === myPeerId);
  broadcastState(); // applyState inside this will call showGame for host too
}

// ═══════════════════════════════════════════════
// GAME ACTIONS (HOST PROCESSES)
// ═══════════════════════════════════════════════
function processAction(fromPeerId, action) {
  const pi = G.players.findIndex(p => p.peerId === fromPeerId);
  if (pi < 0) return;
  const player = G.players[pi];

  if (action.type === 'setup_done') {
    if (G.phase !== 'setup' || player.setupDone) return;
    // action.faceUp: array of card objects player chose as face-up
    const chosen = action.faceUp;
    if (chosen.length !== 3) return;
    // Validate they're all in hand
    const handKeys = player.hand.map(cardKey);
    if (!chosen.every(c => handKeys.includes(cardKey(c)))) return;
    player.faceUp = chosen;
    // Remove from hand
    const chosenKeys = chosen.map(cardKey);
    player.hand = player.hand.filter(c => !chosenKeys.includes(cardKey(c)));
    player.setupDone = true;
    G.setupCount++;
    if (G.setupCount === G.players.length) {
      G.phase = 'play';
      // Determine who goes first: player with lowest card in hand
      // (simplified: just player 0)
      G.currentPlayer = 0;
      broadcastToast('Game started! Player ' + G.players[0].name + ' goes first.', 'good');
    }
    broadcastState();
    return;
  }

  if (action.type === 'play') {
    if (G.phase !== 'play') return;
    if (G.currentPlayer !== pi) return;
    const cards = action.cards; // array of {rank, suit}

    // Validate cards are in player's available pool
    const source = getPlayableSource(player);
    if (!source) return;

    // Validate all cards have same rank
    if (!cards.length || !cards.every(c => c.rank === cards[0].rank)) return;

    // Check if playing from face-down (blind)
    const isBlind = source === 'faceDown';

    if (isBlind) {
      // Can only play one face-down at a time
      if (cards.length !== 1) return;
      const c = cards[0];
      // Check it's actually in faceDown
      if (!player.faceDown.some(fd => fd.rank === c.rank && fd.suit === c.suit)) return;
      // Flip it - check if valid
      if (!canPlay([c], G.playPile)) {
        // Invalid: add to pile, player picks up pile + this card
        player.faceDown = player.faceDown.filter(fd => !(fd.rank === c.rank && fd.suit === c.suit));
        G.playPile.push(c);
        broadcastToast(`${player.name} flipped ${c.rank}${c.suit} — can't play it, picks up the pile!`, 'bad');
        player.hand = player.hand.concat(G.playPile);
        G.playPile = [];
        advanceTurn(pi, false);
        broadcastState();
        return;
      }
      // Valid: play it
      player.faceDown = player.faceDown.filter(fd => !(fd.rank === c.rank && fd.suit === c.suit));
      afterPlay(pi, [c]);
    } else {
      // Playing from hand or face-up
      const poolCards = source === 'hand' ? player.hand : player.faceUp;
      // Validate cards are in pool
      const poolKeys = poolCards.map(cardKey);
      if (!cards.every(c => poolKeys.includes(cardKey(c)))) return;
      // Check playability
      if (!canPlay(cards, G.playPile)) return;
      // Remove from pool
      const playedKeys = cards.map(cardKey);
      if (source === 'hand') {
        player.hand = player.hand.filter(c => !playedKeys.includes(cardKey(c)));
      } else {
        player.faceUp = player.faceUp.filter(c => !playedKeys.includes(cardKey(c)));
      }
      afterPlay(pi, cards);
    }
  }

  if (action.type === 'pickup') {
    if (G.phase !== 'play') return;
    if (G.currentPlayer !== pi) return;
    if (!G.playPile.length) return;
    // Pick up pile
    player.hand = player.hand.concat(G.playPile);
    G.playPile = [];
    broadcastToast(`${player.name} picked up the pile.`, 'bad');
    advanceTurn(pi, false);
    broadcastState();
  }
}

function afterPlay(pi, cards) {
  const player = G.players[pi];
  const rank = cards[0].rank;

  // Add to play pile
  G.playPile.push(...cards);

  // Check for 10 (clear + go again)
  if (rank === '10') {
    G.discard.push(...G.playPile);
    G.playPile = [];
    refillHand(player);
    broadcastToast(`${player.name} played a 10 — pile cleared! Play again.`, 'special');
    broadcastState();
    checkWin(pi);
    return;
  }

  // Check for four of a kind
  if (checkFourOfAKind(G.playPile)) {
    G.discard.push(...G.playPile);
    G.playPile = [];
    refillHand(player);
    broadcastToast(`Four of a kind! Pile cleared — ${player.name} goes again.`, 'special');
    broadcastState();
    checkWin(pi);
    return;
  }

  // 7: next player must play 7 or lower (stored in pile)
  // (this is handled naturally by effectiveTop in canPlay)

  // 2: must play something on top of it next turn (same player or next?)
  // House rule: 2 is wildcard, can be played on anything, then NEXT player must play on top of it
  // So turn advances normally and next player is forced

  refillHand(player);
  advanceTurn(pi, true);
  checkWin(pi);
  broadcastState();
}

function refillHand(player) {
  while (player.hand.length < 3 && G.drawPile.length > 0) {
    player.hand.push(G.drawPile.pop());
  }
}

function advanceTurn(pi, forward) {
  if (forward) {
    G.currentPlayer = (pi + 1) % G.players.length;
    // Skip disconnected players
    let tries = 0;
    while (G.players[G.currentPlayer].disconnected && tries < G.players.length) {
      G.currentPlayer = (G.currentPlayer + 1) % G.players.length;
      tries++;
    }
  } else {
    // Same direction, just advance
    G.currentPlayer = (pi + 1) % G.players.length;
  }
}

function checkWin(pi) {
  const player = G.players[pi];
  if (player.hand.length === 0 && player.faceUp.length === 0 && player.faceDown.length === 0) {
    G.phase = 'over';
    G.winner = pi;
    broadcastToast(`🏆 ${player.name} wins!`, 'special');
    setTimeout(() => {
      broadcast({ type: 'toast', msg: `${player.name} has won the game!`, style: 'special' });
    }, 500);
  }
}

function getPlayableSource(player) {
  if (player.hand.length > 0) return 'hand';
  if (player.faceDown.length === 0 && player.faceUp.length === 0 && player.hand.length === 0) return null;
  if (player.faceUp.length > 0) return 'faceUp';
  if (player.faceDown.length > 0) return 'faceDown';
  return null;
}

// ═══════════════════════════════════════════════
// CLIENT: APPLY STATE + RENDER
// ═══════════════════════════════════════════════
function applyState(state) {
  G = state;
  if (myPlayerIndex < 0) {
    myPlayerIndex = G.players.findIndex(p => p.peerId === myPeerId);
  }
  // Always ensure the game panel is visible before rendering
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

  // Turn indicator
  const isMyTurn = G.phase === 'play' && G.currentPlayer === myPlayerIndex;
  const turnEl = document.getElementById('turn-indicator');
  if (G.phase === 'setup') {
    turnEl.textContent = me.setupDone ? 'Waiting for others…' : 'Choose your face-up cards';
    turnEl.classList.remove('my-turn');
  } else if (G.phase === 'over') {
    turnEl.textContent = G.winner === myPlayerIndex ? '🏆 You Win!' : `${G.players[G.winner]?.name} Wins!`;
    turnEl.classList.toggle('my-turn', G.winner === myPlayerIndex);
    showWinnerModal(G.winner);
  } else {
    const cur = G.players[G.currentPlayer];
    turnEl.textContent = isMyTurn ? 'Your Turn ▶' : `${cur.name}'s Turn`;
    turnEl.classList.toggle('my-turn', isMyTurn);
  }

  // Opponents
  const oppZone = document.getElementById('opponents-zone');
  oppZone.innerHTML = '';
  G.players.forEach((p, i) => {
    if (i === myPlayerIndex) return;
    const div = document.createElement('div');
    div.className = 'opponent-area';
    const isActive = G.currentPlayer === i && G.phase === 'play';
    div.innerHTML = `<span class="opponent-name${isActive ? ' active-player' : ''}">${p.name}${p.disconnected ? ' (left)' : ''}</span>`;

    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'opponent-cards';

    // Face-down cards
    p.faceDown.forEach(() => {
      cardsDiv.appendChild(makeCardEl({ faceDown: true }));
    });

    // Face-up cards
    p.faceUp.forEach(c => {
      cardsDiv.appendChild(makeCardEl(c));
    });

    // Hand cards (face down)
    for (let h = 0; h < p.hand.length; h++) {
      cardsDiv.appendChild(makeCardEl({ faceDown: true }));
    }

    div.appendChild(cardsDiv);
    oppZone.appendChild(div);
  });

  // Draw pile
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

  // Play pile
  const playVis = document.getElementById('play-pile-visual');
  playVis.innerHTML = '';
  if (G.playPile.length > 0) {
    const stack = document.createElement('div');
    stack.className = 'card-pile-stack';
    const cards = G.playPile.slice(-3);
    cards.forEach(c => stack.appendChild(makeCardEl(c)));
    playVis.appendChild(stack);
    const top = topCard(G.playPile);
    document.getElementById('pile-top-label').textContent = `${top.rank}${top.suit} on top (${G.playPile.length})`;
  } else {
    const empty = document.createElement('div');
    empty.className = 'discard-empty';
    empty.textContent = '♠';
    playVis.appendChild(empty);
    document.getElementById('pile-top-label').textContent = 'Empty';
  }

  // My name
  document.getElementById('my-name-label').textContent = me.name + ' (you)';

  // My face-down palace
  renderMyFaceDown(me);

  // My face-up palace
  renderMyFaceUp(me);

  // My hand
  renderMyHand(me);

  // Setup instructions
  const setupInstr = document.getElementById('setup-instructions');
  if (G.phase === 'setup' && !me.setupDone) {
    setupInstr.style.display = 'block';
    const count = setupSelections.length;
    setupInstr.textContent = `Select 3 cards from your hand to place face-up (${count}/3 selected)`;
  } else {
    setupInstr.style.display = 'none';
  }

  // Action buttons
  const playBtn = document.getElementById('btn-play');
  const pickupBtn = document.getElementById('btn-pickup');

  if (G.phase === 'setup' && !me.setupDone) {
    playBtn.textContent = `Confirm Face-Up Cards (${setupSelections.length}/3)`;
    playBtn.disabled = setupSelections.length !== 3;
    pickupBtn.disabled = true;
    pickupBtn.style.display = 'none';
  } else if (G.phase === 'play' && isMyTurn) {
    pickupBtn.style.display = '';
    const source = getPlayableSource(me);
    if (source === 'faceDown') {
      playBtn.textContent = 'Flip a Face-Down Card';
      playBtn.disabled = selectedCards.length !== 1;
    } else {
      playBtn.textContent = selectedCards.length ? `Play ${selectedCards.length} Card${selectedCards.length > 1 ? 's' : ''}` : 'Select Cards to Play';
      playBtn.disabled = selectedCards.length === 0 || !canPlay(selectedCards, G.playPile);
    }
    pickupBtn.disabled = G.playPile.length === 0;
    pickupBtn.textContent = `Pick Up Pile (${G.playPile.length})`;
  } else {
    playBtn.disabled = true;
    playBtn.textContent = 'Play';
    pickupBtn.disabled = true;
    pickupBtn.style.display = G.phase === 'setup' ? 'none' : '';
  }
}

function renderMyFaceDown(me) {
  const el = document.getElementById('my-palace-face-down');
  el.innerHTML = '';
  me.faceDown.forEach((c, i) => {
    const slot = document.createElement('div');
    slot.className = 'palace-slot';
    const card = makeCardEl({ faceDown: true });
    // If it's my turn and source is faceDown, make selectable
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'faceDown') {
      card.classList.add('selectable');
      const isSelected = selectedCards.some(s => s.rank === c.rank && s.suit === c.suit);
      if (isSelected) card.classList.add('selected');
      card.onclick = () => toggleSelectFaceDown(c);
    }
    slot.appendChild(card);
    el.appendChild(slot);
  });
}

function renderMyFaceUp(me) {
  const el = document.getElementById('my-palace-face-up');
  el.innerHTML = '';
  if (G.phase === 'setup' && !me.setupDone) {
    // Show hand cards for selection here actually — hand is rendered below, we highlight selected
    return;
  }
  me.faceUp.forEach(c => {
    const slot = document.createElement('div');
    slot.className = 'palace-slot';
    const card = makeCardEl(c);
    // Selectable if my turn and hand is empty
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'faceUp') {
      card.classList.add('selectable');
      const isSelected = selectedCards.some(s => s.rank === c.rank && s.suit === c.suit);
      if (isSelected) card.classList.add('selected');
      card.onclick = () => toggleSelect(c, 'faceUp');
    }
    slot.appendChild(card);
    el.appendChild(slot);
  });
}

function renderMyHand(me) {
  const el = document.getElementById('my-hand');
  el.innerHTML = '';

  if (G.phase === 'setup' && !me.setupDone) {
    // 6 cards in hand, pick 3 for face-up
    me.hand.forEach(c => {
      const card = makeCardEl(c);
      card.classList.add('selectable');
      const isSelected = setupSelections.some(s => s.rank === c.rank && s.suit === c.suit);
      if (isSelected) card.classList.add('selected');
      card.onclick = () => toggleSetupSelect(c);
      el.appendChild(card);
    });
    return;
  }

  me.hand.forEach(c => {
    const card = makeCardEl(c);
    if (G.phase === 'play' && G.currentPlayer === myPlayerIndex && getPlayableSource(me) === 'hand') {
      card.classList.add('selectable');
      const isSelected = selectedCards.some(s => s.rank === c.rank && s.suit === c.suit);
      if (isSelected) card.classList.add('selected');
      card.onclick = () => toggleSelect(c, 'hand');
    }
    el.appendChild(card);
  });
}

// ═══════════════════════════════════════════════
// CARD ELEMENT BUILDER
// ═══════════════════════════════════════════════
function makeCardEl(c) {
  const el = document.createElement('div');
  el.className = 'card';
  if (c.faceDown) {
    el.classList.add('face-down');
    return el;
  }
  el.classList.add(isRed(c.suit) ? 'red' : 'black');
  el.innerHTML = `
    <div class="card-corner">
      <span>${c.rank}</span>
      <span class="suit-small">${c.suit}</span>
    </div>
    <span class="card-center-suit">${c.suit}</span>
  `;
  return el;
}

// ═══════════════════════════════════════════════
// CARD SELECTION
// ═══════════════════════════════════════════════
function toggleSelect(c, source) {
  const idx = selectedCards.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  if (idx >= 0) {
    selectedCards.splice(idx, 1);
  } else {
    // Can only select same rank as already selected
    if (selectedCards.length > 0 && selectedCards[0].rank !== c.rank) {
      selectedCards = [c];
    } else {
      selectedCards.push(c);
    }
  }
  renderGame();
}

function toggleSelectFaceDown(c) {
  // For face-down, only select one at a time
  const idx = selectedCards.findIndex(s => s.rank === c.rank && s.suit === c.suit);
  if (idx >= 0) {
    selectedCards = [];
  } else {
    selectedCards = [c];
  }
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
    if (source === 'faceDown' && selectedCards.length === 1) {
      sendToHost({ type: 'play', cards: selectedCards });
    } else if (selectedCards.length > 0) {
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

function showLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

function clearLobbyError() {
  document.getElementById('lobby-error').textContent = '';
}

function showWinnerModal(winnerIdx) {
  if (!G) return;
  const modal = document.getElementById('winner-modal');
  if (modal.style.display === 'flex') return; // already shown
  modal.style.display = 'flex';
  const winner = G.players[winnerIdx];
  document.getElementById('winner-title').textContent = winnerIdx === myPlayerIndex ? '🏆 You Win!' : `${winner.name} Wins!`;
  document.getElementById('winner-msg').textContent = winnerIdx === myPlayerIndex
    ? 'Congratulations! You cleared all your cards first.'
    : `${winner.name} was the first to empty all their cards.`;
}

// Rules
document.getElementById('btn-rules').onclick = () => {
  document.getElementById('rules-modal').style.display = 'flex';
};

// Enter key for lobby inputs
document.getElementById('player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-host').click();
});
document.getElementById('room-code-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

// Auto-uppercase room code input
document.getElementById('room-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});