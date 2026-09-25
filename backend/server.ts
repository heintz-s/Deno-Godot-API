// server.ts
// Starten mit: deno run --allow-net --allow-env --env-file=.env server.ts

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
// KONFIGURATION: API-Key kommt aus der Umgebung (.env), NICHT aus dem Code!
// ============================================================================
const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY");
const MISTRAL_MODEL = Deno.env.get("MISTRAL_MODEL") ?? "mistral-small-latest";
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

if (!MISTRAL_API_KEY) {
  console.warn("⚠️  MISTRAL_API_KEY ist nicht gesetzt – der Bot nutzt nur Fallback-Sätze.");
}

// ============================================================================
// HIER ARBEITEN DIE STUDIERENDEN: EXTERNE KI / API ANRUFEN
// ============================================================================
async function callAiBot(lastSentence: string): Promise<string> {
  if (!MISTRAL_API_KEY) {
    return "[Bot]: Und dann nahm die Geschichte eine seltsame Wendung.";
  }

  try {
    const res = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        temperature: 0.9,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "Du spielst ein Spiel, bei dem eine Geschichte Satz für Satz weitergeschrieben wird. " +
              "Schreibe genau EINEN kurzen, kreativen Folgesatz auf Deutsch (maximal 15 Wörter). " +
              "Antworte NUR mit diesem einen Satz, ohne Einleitung und ohne Anführungszeichen.",
          },
          {
            role: "user",
            content: `Letzter Satz der Geschichte: "${lastSentence}"`,
          },
        ],
      }),
      // Nicht ewig warten, falls die API hängt
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Mistral HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";

    // Eventuelle Anführungszeichen am Anfang/Ende bereinigen
    const cleanText = text.trim().replace(/^["'„“]|["'“”]$/g, "");

    return cleanText || "[Bot]: Plötzlich geschah etwas Unerwartetes.";
  } catch (err) {
    console.error("Fehler beim Mistral-Aufruf:", err);
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