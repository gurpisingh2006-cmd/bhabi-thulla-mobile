const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Socket.io con Heartbeat/Ping ottimizzati per dispositivi mobili
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: "*" }
});

app.use(express.static('public'));

const rooms = {};

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
  return deck.sort(() => Math.random() - 0.5);
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
  let playerId = null;

  socket.on('joinRoom', ({ roomCode, playerName, sessionToken }) => {
    currentRoom = roomCode.toUpperCase();
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
        winnersList: []
      };
    }

    const room = rooms[currentRoom];
    
    // Gestione Riconnessione
    let existingPlayer = room.players.find(p => p.token === sessionToken);

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      playerId = socket.id;
    } else if (!room.started && room.players.length < 5) {
      playerId = socket.id;
      room.players.push({
        id: socket.id,
        token: sessionToken,
        name: playerName || 'Giocatore',
        isBot: false,
        cards: [],
        isSafe: false,
        connected: true
      });
    }

    if (room.started) {
      io.to(currentRoom).emit('gameState', { room, event: 'reconnect' });
    } else {
      io.to(currentRoom).emit('roomState', room);
    }
  });

  socket.on('addBot', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
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
      io.to(currentRoom).emit('roomState', room);
    }
  });

  socket.on('startGame', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.players.length < 2) return;

    room.started = true;
    room.isResolving = false;
    room.isFirstTurnEver = true;
    room.winnersList = [];
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

    io.to(currentRoom).emit('gameState', { room, event: 'start' });
    checkBotTurn(room);
  });

  socket.on('playCard', (cardId) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.isResolving) return;

    const player = room.players[room.turnIndex];
    if (!player || player.id !== socket.id) return;

    executeMove(room, player, cardId, socket);
  });

  function executeMove(room, player, cardId, socket = null) {
    const cardIdx = player.cards.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;

    const card = player.cards[cardIdx];

    if (room.isFirstTurnEver && room.currentTrick.length === 0) {
      if (!(card.suit === 'S' && card.value === 'A')) {
        if (socket) socket.emit('errorMsg', 'Devi giocare l\'Asso di Picche (A♠) come prima carta!');
        return;
      }
    }

    if (room.leadSuit && card.suit !== room.leadSuit) {
      const hasLeadSuit = player.cards.some(c => c.suit === room.leadSuit);
      if (hasLeadSuit) {
        const suitNames = { 'S': 'Picche ♠', 'H': 'Cuori ♥', 'D': 'Quadri ♦', 'C': 'Fiori ♣' };
        if (socket) socket.emit('errorMsg', `Devi rispondere con il seme della presa (${suitNames[room.leadSuit]})!`);
        return;
      }
    }

    player.cards.splice(cardIdx, 1);

    if (room.currentTrick.length === 0) {
      room.leadSuit = card.suit;
    }

    const isThulla = room.leadSuit && card.suit !== room.leadSuit;
    room.currentTrick.push({ player, card });

    const activePlayers = getActivePlayers(room);

    if (isThulla) {
      room.isResolving = true;
      room.isFirstTurnEver = false;
      io.to(room.code).emit('gameState', { room, event: 'play', playedBy: player.name });

      setTimeout(() => {
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
        io.to(room.code).emit('gameState', { room, event: 'thulla', playedBy: player.name });

        if (!checkGameOver(room)) checkBotTurn(room);
      }, 1500);

    } else if (room.currentTrick.length === activePlayers.length) {
      room.isResolving = true;
      room.isFirstTurnEver = false;
      io.to(room.code).emit('gameState', { room, event: 'play', playedBy: player.name });

      setTimeout(() => {
        let highestCard = null;
        let winnerIdx = -1;

        room.currentTrick.forEach(item => {
          if (item.card.suit === room.leadSuit) {
            if (!highestCard || item.card.rank > highestCard.rank) {
              highestCard = item.card;
              winnerIdx = room.players.findIndex(p => p.id === item.player.id);
            }
          }
        });

        room.currentTrick = [];
        room.leadSuit = null;

        checkSafety(room);

        if (room.players[winnerIdx].isSafe) {
          advanceTurnFrom(room, winnerIdx);
        } else {
          room.turnIndex = winnerIdx;
        }

        room.isResolving = false;
        io.to(room.code).emit('gameState', { room, event: 'trick_win', playedBy: player.name });

        if (!checkGameOver(room)) checkBotTurn(room);
      }, 1500);

    } else {
      advanceTurn(room);
      checkSafety(room);
      io.to(room.code).emit('gameState', { room, event: 'play', playedBy: player.name });

      if (!checkGameOver(room)) checkBotTurn(room);
    }
  }

  function advanceTurn(room) {
    advanceTurnFrom(room, room.turnIndex);
  }

  function advanceTurnFrom(room, startIndex) {
    let nextIdx = startIndex;
    do {
      nextIdx = (nextIdx + 1) % room.players.length;
    } while (room.players[nextIdx].isSafe);
    room.turnIndex = nextIdx;
  }

  function getActivePlayers(room) {
    return room.players.filter(p => !p.isSafe);
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
    const active = getActivePlayers(room);
    if (active.length === 1) {
      const loser = active[0].name;
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
        if (room.isResolving) return;

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

      // Controlla se ci sono ancora umani connessi nella stanza
      const activeHumanPlayers = room.players.filter(p => !p.isBot && p.connected);

      // Se non ci sono più giocatori umani connessi, elimina la stanza
      if (activeHumanPlayers.length === 0) {
        delete rooms[currentRoom];
        console.log(`Stanza ${currentRoom} eliminata perché vuota o inattiva.`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server attivo su porta ${PORT}`));