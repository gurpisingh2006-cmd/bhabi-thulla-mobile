const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: "*" }
});

app.use(express.static('public'));

const rooms = {};

// Non inviare mai l'intero stato interno ai client: contiene le mani di tutti.
function publicRoomState(room, recipientToken) {
  const players = room.players.map(p => ({
    id: p.id,
    token: p.token,
    name: p.name,
    isBot: p.isBot,
    isSafe: p.isSafe,
    connected: p.connected,
    cardCount: p.cards.length,
    cards: p.token === recipientToken ? p.cards.map(c => ({ ...c })) : []
  }));
  const playerById = new Map(players.map(p => [p.id, p]));
  return {
    code: room.code,
    players,
    started: room.started,
    currentTrick: room.currentTrick.map(item => ({
      card: { ...item.card },
      player: playerById.get(item.player.id) || {
        id: item.player.id, name: item.player.name, isBot: item.player.isBot
      }
    })),
    leadSuit: room.leadSuit,
    turnIndex: room.turnIndex,
    isResolving: room.isResolving,
    isFirstTurnEver: room.isFirstTurnEver,
    winnersList: [...room.winnersList]
  };
}

function emitRoomState(room) {
  for (const p of room.players) {
    if (!p.isBot && p.connected) {
      io.to(p.id).emit('roomState', publicRoomState(room, p.token));
    }
  }
}

function emitGameState(room, event, extra = {}) {
  for (const p of room.players) {
    if (!p.isBot && p.connected) {
      io.to(p.id).emit('gameState', {
        room: publicRoomState(room, p.token),
        event,
        ...extra
      });
    }
  }
}

const SUITS = ['S', 'H', 'D', 'C'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
const SUIT_ORDER = { 'S': 1, 'H': 2, 'D': 3, 'C': 4 };

function createDeck() {
  const deck = [];
  let id = 1;
  for (let s of SUITS) {
    for (let v of VALUES) {
      deck.push({ id: id++, suit: s, value: v, rank: RANK[v] });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = require('crypto').randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortCards(cards) {
  return cards.sort((a, b) => {
    if (SUIT_ORDER[a.suit] !== SUIT_ORDER[b.suit]) {
      return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    }
    return b.rank - a.rank;
  });
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('joinRoom', (payload = {}) => {
    const roomCode = typeof payload.roomCode === 'string' ? payload.roomCode.trim().toUpperCase() : '';
    const playerName = typeof payload.playerName === 'string' ? payload.playerName.trim().slice(0, 12) : '';
    const sessionToken = typeof payload.sessionToken === 'string' ? payload.sessionToken : '';
    if (!/^[A-Z0-9_-]{1,8}$/.test(roomCode) || !/^[a-zA-Z0-9_-]{8,120}$/.test(sessionToken)) {
      socket.emit('errorMsg', 'Nome stanza o sessione non valido.');
      return;
    }
    if (currentRoom && currentRoom !== roomCode) {
      const previous = rooms[currentRoom];
      if (previous) {
        const oldPlayer = previous.players.find(p => p.id === socket.id);
        if (oldPlayer) oldPlayer.connected = false;
      }
      socket.leave(currentRoom);
    }
    currentRoom = roomCode;
    socket.join(currentRoom);

    if (!rooms[currentRoom]) {
      rooms[currentRoom] = {
        code: currentRoom,
        players: [],
        started: false,
        currentTrick: [],
        leadSuit: null,
        turnIndex: 0,
        isResolving: false,
        isFirstTurnEver: true,
        winnersList: [],
        pendingCardRequests: {}
      };
    }

    const room = rooms[currentRoom];
    let existingPlayer = room.players.find(p => p.token === sessionToken);

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      if (playerName) existingPlayer.name = playerName;
    } else if (!room.started && room.players.length < 5) {
      room.players.push({
        id: socket.id,
        token: sessionToken,
        name: playerName || 'Giocatore',
        isBot: false,
        cards: [],
        isSafe: false,
        connected: true
      });
    } else if (!existingPlayer) {
      socket.leave(currentRoom);
      currentRoom = null;
      socket.emit('errorMsg', room.started ? 'La partita è già iniziata.' : 'La stanza è piena.');
      return;
    }

    if (room.started) {
      emitGameState(room, 'reconnect');
    } else {
      emitRoomState(room);
    }
  });

  socket.on('addBot', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.players.some(p => p.id === socket.id)) return;
    if (!room.started && room.players.length < 5) {
      const botCount = room.players.filter(p => p.isBot).length + 1;
      room.players.push({
        id: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        token: 'bot_token_' + Date.now(),
        name: `Bot ${botCount}`,
        isBot: true,
        cards: [],
        isSafe: false,
        connected: true
      });
      emitRoomState(room);
    }
  });

  socket.on('startGame', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.players.some(p => p.id === socket.id)) {
      socket.emit('errorMsg', 'Non fai parte di questa stanza.');
      return;
    }
    if (room.started) {
      socket.emit('errorMsg', 'La partita è già iniziata.');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('errorMsg', 'Servono almeno 2 giocatori per iniziare.');
      return;
    }

    room.started = true;
    room.isResolving = false;
    room.isFirstTurnEver = true;
    room.winnersList = [];
    room.pendingCardRequests = {};
    const deck = createDeck();
    
    room.players.forEach(p => {
      p.cards = [];
      p.isSafe = false;
    });

    let pIdx = 0;
    while (deck.length > 0) {
      room.players[pIdx].cards.push(deck.pop());
      pIdx = (pIdx + 1) % room.players.length;
    }

    let starterIndex = 0;
    room.players.forEach((p, idx) => {
      sortCards(p.cards);
      if (p.cards.some(c => c.suit === 'S' && c.value === 'A')) {
        starterIndex = idx;
      }
    });

    room.turnIndex = starterIndex;
    room.currentTrick = [];
    room.leadSuit = null;

    emitGameState(room, 'start');
    checkBotTurn(room);
  });

  socket.on('playCard', (cardId) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!room.started || room.isResolving) return;

    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id) return;

    executeMove(room, player, cardId, socket);
  });

  socket.on('requestCardFrom', ({ targetPlayerId }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const requester = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetPlayerId);

    if (!room.started || room.isResolving || !requester || requester.isSafe) return;
    if (!target || target.id === requester.id || target.cards.length === 0 || target.isSafe) {
      socket.emit('errorMsg', 'Questo giocatore non ha carte da dare o non è disponibile.');
      return;
    }

    if (target.isBot) {
      transferAllCards(room, target, requester);
    } else {
      room.pendingCardRequests[target.id] = {
        requesterId: requester.id,
        targetId: target.id,
        expiresAt: Date.now() + 30000
      };
      io.to(target.id).emit('cardRequestPrompt', {
        requesterId: requester.id,
        requesterName: requester.name
      });
      socket.emit('errorMsg', `Richiesta inviata a ${target.name}. In attesa di conferma...`);
    }
  });

  socket.on('respondCardRequest', ({ requesterId, accepted }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const target = room.players.find(p => p.id === socket.id);
    const requester = room.players.find(p => p.id === requesterId);
    const pending = room.pendingCardRequests[socket.id];

    if (!room.started || room.isResolving || !target || !requester || !pending ||
        pending.requesterId !== requester.id || pending.targetId !== target.id ||
        pending.expiresAt < Date.now() || target.isSafe || requester.isSafe ||
        target.id === requester.id) {
      if (target) delete room.pendingCardRequests[target.id];
      return;
    }
    delete room.pendingCardRequests[target.id];

    if (accepted && target.cards.length > 0) {
      transferAllCards(room, target, requester);
      io.to(target.id).emit('errorMsg', `Hai accettato e dato TUTTE le tue carte a ${requester.name}.`);
    } else {
      io.to(requester.id).emit('errorMsg', `${target.name} ha rifiutato di darti le carte.`);
    }
  });

  function transferAllCards(room, donor, receiver) {
    if (!room.started || room.isResolving || !donor || !receiver ||
        donor.id === receiver.id || donor.isSafe || receiver.isSafe ||
        donor.cards.length === 0) return;
    const givenCards = [...donor.cards];
    receiver.cards.push(...givenCards);
    donor.cards = []; 

    sortCards(receiver.cards);

    checkSafety(room);
    emitGameState(room, 'play', { playedBy: receiver.name });
    io.to(room.code).emit('errorMsg', `🤝 ${donor.name} ha dato TUTTE le sue carte a ${receiver.name}!`);
  }

  function executeMove(room, player, cardId, socket = null) {
    const cardIdx = player.cards.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const card = player.cards[cardIdx];

    if (room.isFirstTurnEver && room.currentTrick.length === 0) {
      const hasAceOfSpades = player.cards.some(c => c.suit === 'S' && c.value === 'A');
      if (hasAceOfSpades && !(card.suit === 'S' && card.value === 'A')) {
        if (socket) socket.emit('errorMsg', 'Hai l\'Asso di Picche (A♠) in mano, devi giocarlo per forza!');
        return;
      }
    }

    if (room.leadSuit && card.suit !== room.leadSuit) {
      const hasLeadSuit = player.cards.some(c => c.suit === room.leadSuit);
      if (hasLeadSuit) {
        if (!room.isFirstTurnEver) {
          const suitNames = { 'S': 'Picche ♠', 'H': 'Cuori ♥', 'D': 'Quadri ♦', 'C': 'Fiori ♣' };
          if (socket) socket.emit('errorMsg', `Devi rispondere con il seme della presa (${suitNames[room.leadSuit]})!`);
          return;
        }
      }
    }

    player.cards.splice(cardIdx, 1);

    if (room.currentTrick.length === 0) {
      room.leadSuit = card.suit;
    }

    let isThulla = false;
    if (room.leadSuit && card.suit !== room.leadSuit) {
      if (room.isFirstTurnEver) {
        const hasLeadSuit = player.cards.some(c => c.suit === room.leadSuit) || (card.suit === room.leadSuit);
        isThulla = hasLeadSuit;
      } else {
        isThulla = true;
      }
    }

    room.currentTrick.push({ player, card });

    const activePlayersCount = room.players.filter(p => !p.isSafe).length;

    if (isThulla) {
      room.isResolving = true;
      room.isFirstTurnEver = false;
      emitGameState(room, 'play', { playedBy: player.name });

      setTimeout(() => {
        if (rooms[room.code] !== room || !room.started || !room.isResolving) return;
        let highestCard = null;
        let highestPlayerIdx = -1;

        room.currentTrick.forEach(item => {
          if (item.card.suit === room.leadSuit) {
            if (!highestCard || item.card.rank > highestCard.rank) {
              highestCard = item.card;
              highestPlayerIdx = room.players.findIndex(p => p.id === item.player.id);
            }
          }
        });

        const penaltyPlayer = room.players[highestPlayerIdx];
        const trickCards = room.currentTrick.map(t => t.card);
        penaltyPlayer.cards.push(...trickCards);
        sortCards(penaltyPlayer.cards);

        room.currentTrick = [];
        room.leadSuit = null;
        
        checkSafety(room);

        if (room.players[highestPlayerIdx].isSafe) {
          advanceTurnFrom(room, highestPlayerIdx);
        } else {
          room.turnIndex = highestPlayerIdx;
        }

        room.isResolving = false;
        emitGameState(room, 'thulla', { playedBy: player.name });

        if (!checkGameOver(room)) checkBotTurn(room);
      }, 1500);

    } else if (room.currentTrick.length >= activePlayersCount) {
      room.isResolving = true;
      room.isFirstTurnEver = false;
      emitGameState(room, 'play', { playedBy: player.name });

      setTimeout(() => {
        if (rooms[room.code] !== room || !room.started || !room.isResolving) return;
        let winnerIdx = -1;
        let highestCard = null;

        room.currentTrick.forEach(item => {
          if (item.card.suit === room.leadSuit) {
            if (!highestCard || item.card.rank > highestCard.rank) {
              highestCard = item.card;
              winnerIdx = room.players.findIndex(p => p.id === item.player.id);
            }
          }
        });

        // -------------------------------------------------------------------------
        // CONTROLLO PENALITÀ ULTIMA CARTA PESANTE
        // Se un giocatore rimane con 0 carte dopo questa mossa, verifichiamo se la sua 
        // carta giocata era più pesante della carta vincente del leadSuit.
        // Se è più pesante, NON può chiudere: riceve le carte del trick come penalità!
        // -------------------------------------------------------------------------
        room.currentTrick.forEach(item => {
          if (item.player.cards.length === 0 && !item.player.isSafe) {
            // Controlliamo se la sua carta appartiene al seme guida ed è più alta di quella del vincitore
            if (item.card.suit === room.leadSuit && item.card.rank > highestCard.rank) {
              const penaltyCards = room.currentTrick.map(t => t.card);
              item.player.cards.push(...penaltyCards);
              sortCards(item.player.cards);
              
              io.to(room.code).emit('errorMsg', `⚠️ ${item.player.name} ha esaurito le carte ma la sua carta era più pesante! Prende penalità e continua.`);
            }
          }
        });

        room.currentTrick = [];
        room.leadSuit = null;

        // Ora possiamo controllare in sicurezza chi è davvero salvo
        checkSafety(room);

        if (winnerIdx !== -1 && room.players[winnerIdx]) {
          if (room.players[winnerIdx].isSafe) {
            advanceTurnFrom(room, winnerIdx);
          } else {
            room.turnIndex = winnerIdx;
          }
        } else {
          advanceTurn(room);
        }

        room.isResolving = false;
        emitGameState(room, 'trick_win', { playedBy: player.name });

        if (!checkGameOver(room)) checkBotTurn(room);
      }, 1500);

    } else {
      advanceTurn(room);
      checkSafety(room);
      emitGameState(room, 'play', { playedBy: player.name });

      if (!checkGameOver(room)) checkBotTurn(room);
    }
  }

  function advanceTurn(room) {
    advanceTurnFrom(room, room.turnIndex);
  }

  function advanceTurnFrom(room, startIndex) {
    const count = room.players.length;
    if (count === 0) return -1;
    const active = room.players.filter(p => !p.isSafe);
    if (active.length === 0) return -1;
    let nextIdx = startIndex;
    for (let checked = 0; checked < count; checked++) {
      nextIdx = (nextIdx + 1) % count;
      if (!room.players[nextIdx].isSafe) {
        room.turnIndex = nextIdx;
        return nextIdx;
      }
    }
    return -1;
  }

  function checkSafety(room) {
    room.players.forEach(p => {
      if (!p.isSafe && p.cards.length === 0) {
        p.isSafe = true;
        room.winnersList.push(p.name);
      }
    });
  }

  function checkGameOver(room) {
    const active = room.players.filter(p => !p.isSafe);
    if (active.length <= 1) {
      const loser = active.length === 1 ? active[0].name : (room.winnersList[room.winnersList.length - 1] || 'Sconosciuto');
      io.to(room.code).emit('gameOver', { 
        loser: loser,
        winners: room.winnersList
      });
      delete rooms[room.code];
      return true;
    }
    return false;
  }

  function checkBotTurn(room) {
    if (room.isResolving) return;
    const activePlayer = room.players[room.turnIndex];

    if (activePlayer && activePlayer.isBot && !activePlayer.isSafe) {
      setTimeout(() => {
        if (!room.started || room.isResolving ||
            room.players[room.turnIndex] !== activePlayer ||
            activePlayer.isSafe || activePlayer.cards.length === 0) return;

        let playableCards = [...activePlayer.cards];

        if (room.isFirstTurnEver && room.currentTrick.length === 0) {
          const aceSpades = activePlayer.cards.find(c => c.suit === 'S' && c.value === 'A');
          if (aceSpades) playableCards = [aceSpades];
        } else if (room.leadSuit) {
          const suitCards = activePlayer.cards.filter(c => c.suit === room.leadSuit);
          if (suitCards.length > 0) playableCards = suitCards;
        }

        if (playableCards.length > 0) {
          const chosenCard = playableCards[Math.floor(Math.random() * playableCards.length)];
          executeMove(room, activePlayer, chosenCard.id);
        }
      }, 1000);
    }
  }

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.connected = false;
      }
      delete room.pendingCardRequests[socket.id];

      const activeHumanPlayers = room.players.filter(p => !p.isBot && p.connected);
      if (activeHumanPlayers.length === 0) {
        delete rooms[currentRoom];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server attivo su porta ${PORT}`));
