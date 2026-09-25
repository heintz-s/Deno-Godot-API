// server.ts
// Starten mit: deno run --allow-net --allow-env server.ts

interface Player {
  id: string;
  name: string;
  ws: WebSocket;
}

interface Room {
  id: string;
  players: Player[];
  sentences: string[];
  turnIndex: number;
  maxTurns: number;
}

const rooms = new Map<string, Room>();

// ============================================================================
// HIER ARBEITEN DIE STUDIERENDEN: EXTERNE KI / API ANRUFEN
// ============================================================================
async function callAiBot(lastSentence: string): Promise<string> {

  try {
    const prompt = `Du spielst ein Spiel, bei dem eine Geschichte Satz für Satz weitergeschrieben wird. Schreibe genau EINEN kurzen, kreativen Folgesatz auf Deutsch (maximal 15 Wörter), der hieran anknüpft: "${lastSentence}". Antworte NUR mit diesem einen Satz, keine Einleitung, keine Anführungszeichen.`;

    const url = `https://text.pollinations.ai/${encodeURIComponent(prompt)}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/plain, */*",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      },
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Pollinations HTTP ${res.status}: ${errBody}`);
    }

    const text = await res.text();
    // Eventuelle Anführungszeichen am Anfang/Ende bereinigen
    const cleanText = text.trim().replace(/^["']|["']$/g, "");

    return cleanText || "[Bot]: Plötzlich geschah etwas Unerwartetes.";
  } catch (err) {
    console.error("Fehler beim Pollinations-Aufruf:", err);
    return "[Bot]: Und dann nahm die Geschichte eine seltsame Wendung.";
  }
}
// ============================================================================
// WEBSOCKET GAME ENGINE (Müssen Studierende kaum verändern)
// ============================================================================
Deno.serve({ port: 8080 }, (req) => {
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Game Server läuft auf Port 8080!", { status: 200 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  let currentRoom: Room | null = null;
  let player: Player | null = null;

  socket.onmessage = async (e) => {
    const data = JSON.parse(e.data);

    // 1. Spieler tritt bei
    if (data.type === "join") {
      // Doppeltes Beitreten über denselben Socket verhindern
      if (player) return;

      const roomId = data.roomId || "lobby";
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          players: [],
          sentences: [],
          turnIndex: 0,
          maxTurns: 6, // Nach 6 Sätzen ist die Geschichte fertig
        });
      }
      const room = rooms.get(roomId)!;

      if (room.players.length >= 2) {
        socket.send(JSON.stringify({ type: "error", message: "Raum ist voll!" }));
        return;
      }

      currentRoom = room;

      // FIX: Eindeutige ID statt `p${players.length + 1}`
      // (sonst können nach einem Reconnect zwei Spieler dieselbe ID haben)
      player = { id: crypto.randomUUID(), name: data.name, ws: socket };
      currentRoom.players.push(player);

      socket.send(JSON.stringify({ type: "joined", myId: player.id }));

      if (currentRoom.players.length === 2) {
        // Spiel starten: Spieler 1 beginnt
        triggerNextTurn(currentRoom);
      } else {
        socket.send(JSON.stringify({ type: "waiting", message: "Warte auf zweiten Spieler..." }));
      }
    }

    // 2. Spieler sendet Satz ab
    if (data.type === "submit_sentence" && currentRoom && player) {
      // Nur der aktive Spieler darf einen Satz abschicken
      if (currentRoom.players.length < 2 || getActivePlayer(currentRoom) !== player) {
        socket.send(JSON.stringify({ type: "error", message: "Du bist gerade nicht am Zug!" }));
        return;
      }

      currentRoom.sentences.push(data.text);
      currentRoom.turnIndex++;
      await handleGameProgression(currentRoom);
    }
  };

  socket.onclose = () => {
    if (currentRoom && player) {
      currentRoom.players = currentRoom.players.filter((p) => p !== player);

      // FIX: Spielstand zurücksetzen, damit ein neuer Mitspieler sauber startet
      currentRoom.sentences = [];
      currentRoom.turnIndex = 0;

      broadcast(currentRoom, { type: "player_left", message: "Mitspieler hat das Spiel verlassen." });
      if (currentRoom.players.length === 0) rooms.delete(currentRoom.id);
    }
  };

  return response;
});

function getActivePlayer(room: Room): Player | undefined {
  const activeIndex = (room.turnIndex % 3) % 2;
  return room.players[activeIndex];
}

async function handleGameProgression(room: Room) {
  // Ist das Spiel vorbei?
  if (room.sentences.length >= room.maxTurns) {
    broadcast(room, {
      type: "game_over",
      fullStory: room.sentences.join(" "),
    });
    return;
  }

  // Jeder 3. Zug gehört der KI (z. B. Zug Index 2, 5...)
  if (room.turnIndex % 3 === 2) {
    broadcast(room, { type: "bot_thinking", message: "🤖 KI-Bot schreibt die Geschichte weiter..." });

    const botSentence = await callAiBot(room.sentences.at(-1)!);
    room.sentences.push(botSentence);
    room.turnIndex++;

    // Nach dem Bot direkt prüfen, ob Limit erreicht ist
    if (room.sentences.length >= room.maxTurns) {
      broadcast(room, { type: "game_over", fullStory: room.sentences.join(" ") });
      return;
    }
  }

  // Nächsten menschlichen Spieler aktivieren
  triggerNextTurn(room);
}

function triggerNextTurn(room: Room) {
  // 1. Aktiven Spieler ermitteln
  const activePlayer = getActivePlayer(room);
  if (!activePlayer) return; // z. B. wenn ein Spieler inzwischen gegangen ist

  const actualLastSentence = room.sentences.length > 0
    ? room.sentences.at(-1)!
    : "(Beginne die Geschichte!)";

  // 2. An JEDEN Spieler eine eigene, gefilterte Nachricht senden
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      // FIX: Objekte direkt vergleichen statt IDs
      const isTurn = (p === activePlayer);

      // Hier wird serverseitig zensiert:
      const payload = {
        type: "new_turn",
        activePlayerId: activePlayer.id,
        // Der wartende Spieler erhält serverseitig NIEMALS den Text:
        lastSentence: isTurn ? actualLastSentence : "🔒 (Verdeckt – Mitspieler schreibt...)",
      };

      p.ws.send(JSON.stringify(payload));
    }
  }
}

function broadcast(room: Room, msg: object) {
  const json = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(json);
    }
  }
}