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
  const apiKey = Deno.env.get("GROQ_API_KEY");

  // Fallback, falls kein API-Key gesetzt ist (funktioniert auch offline!)
  if (!apiKey) {
    return `[Bot]: Plötzlich tauchte eine mysteriöse Katze auf und miaute zu: "${lastSentence}".`;
  }

  // Echter KI-Aufruf (z. B. Groq / Llama 3)
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: "Du spielst ein Spiel, bei dem eine Geschichte Satz für Satz weitergeschrieben wird. Schreibe genau EINEN kurzen, kreativen Folgesatz auf Deutsch (maximal 15 Wörter)."
        },
        { role: "user", content: `Der vorherige Satz war: "${lastSentence}"` }
      ],
      max_tokens: 50,
    }),
  });

  const data = await res.json();
  return data.choices[0].message.content.trim();
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
      currentRoom = rooms.get(roomId)!;

      if (currentRoom.players.length >= 2) {
        socket.send(JSON.stringify({ type: "error", message: "Raum ist voll!" }));
        return;
      }

      player = { id: `p${currentRoom.players.length + 1}`, name: data.name, ws: socket };
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
      currentRoom.sentences.push(data.text);
      currentRoom.turnIndex++;
      await handleGameProgression(currentRoom);
    }
  };

  socket.onclose = () => {
    if (currentRoom && player) {
      currentRoom.players = currentRoom.players.filter((p) => p !== player);
      broadcast(currentRoom, { type: "player_left", message: "Mitspieler hat das Spiel verlassen." });
      if (currentRoom.players.length === 0) rooms.delete(currentRoom.id);
    }
  };

  return response;
});

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
  const activeIndex = (room.turnIndex % 3) % 2;
  const activePlayer = room.players[activeIndex];
  const lastSentence = room.sentences.length > 0 
    ? room.sentences.at(-1) 
    : "(Beginne die Geschichte!)";

  // An jeden Spieler eine individuell gefilterte Nachricht senden:
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      const isTurn = (p.id === activePlayer.id);

      p.ws.send(JSON.stringify({
        type: "new_turn",
        activePlayerId: activePlayer.id,
        // Nur der Aktive sieht den Text, der andere sieht ihn verdeckt:
        lastSentence: isTurn ? lastSentence : "🔒 (Verdeckt – Mitspieler schreibt...)",
      }));
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