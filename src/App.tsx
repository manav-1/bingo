import { useEffect, useMemo, useRef, useState } from "react";
import Peer, { DataConnection } from "peerjs";
import {
  Check,
  Copy,
  Crown,
  Dices,
  LogOut,
  Play,
  RefreshCw,
  Send,
  Share2,
  Users,
} from "lucide-react";

type Phase = "HOME" | "LOBBY" | "BOARD_SETUP" | "PLAYING" | "GAME_OVER";
type PoolRange = [number, number];
type LineId =
  | "ROW_0"
  | "ROW_1"
  | "ROW_2"
  | "ROW_3"
  | "ROW_4"
  | "COL_0"
  | "COL_1"
  | "COL_2"
  | "COL_3"
  | "COL_4"
  | "DIAG_MAIN"
  | "DIAG_ANTI";

type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  locked: boolean;
  lineCount: number;
};

type BoardState = {
  playerId: string;
  grid: number[][];
  marked: boolean[][];
  completedLines: LineId[];
};

type HistoryEntry = {
  id: string;
  playerId: string;
  playerName: string;
  number: number | null;
  text: string;
};

type Snapshot = {
  phase: Phase;
  roomCode: string;
  poolRange: PoolRange;
  players: PlayerSummary[];
  boards: Record<string, BoardState>;
  calledNumbers: number[];
  turnOrder: string[];
  currentPlayerId: string | null;
  history: HistoryEntry[];
  winners: string[];
};

type Message =
  | { type: "JOIN_REQUEST"; playerName: string; playerId?: string }
  | { type: "JOIN_ACCEPTED"; playerId: string; poolRange: PoolRange; players: PlayerSummary[] }
  | { type: "PLAYER_LIST_UPDATE"; players: PlayerSummary[] }
  | { type: "START_BOARD_SETUP"; poolRange: PoolRange }
  | { type: "BOARD_SUBMIT"; playerId: string; board: number[][] }
  | { type: "BOARD_LOCKED"; playerId: string }
  | { type: "ALL_BOARDS_READY"; turnOrder: string[] }
  | { type: "YOUR_TURN"; playerId: string; remainingPool: number[] }
  | { type: "CALL_NUMBER"; playerId: string; number: number }
  | { type: "NUMBER_CALLED"; number: number; calledBy: string; nextPlayerId: string | null }
  | { type: "LINE_UPDATE"; playerId: string; completedLines: LineId[]; lineCount: number }
  | { type: "GAME_OVER"; winners: string[]; finalBoards: Record<string, BoardState> }
  | { type: "PLAYER_DISCONNECTED"; playerId: string }
  | { type: "REMATCH_REQUEST" }
  | { type: "ERROR"; message: string }
  | { type: "STATE_SYNC"; snapshot: Snapshot };

const emptyMarks = () => Array.from({ length: 5 }, () => Array(5).fill(false));
const emptyManual = () => Array.from({ length: 5 }, () => Array(5).fill(""));
const lineIds: LineId[] = [
  "ROW_0",
  "ROW_1",
  "ROW_2",
  "ROW_3",
  "ROW_4",
  "COL_0",
  "COL_1",
  "COL_2",
  "COL_3",
  "COL_4",
  "DIAG_MAIN",
  "DIAG_ANTI",
];
const DEFAULT_POOL_RANGE: PoolRange = [1, 25];

const initialSnapshot: Snapshot = {
  phase: "HOME",
  roomCode: "",
  poolRange: DEFAULT_POOL_RANGE,
  players: [],
  boards: {},
  calledNumbers: [],
  turnOrder: [],
  currentPlayerId: null,
  history: [],
  winners: [],
};

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function normalizeCode(code: string) {
  return code.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 5);
}

function getStoredPlayerId() {
  const existing = sessionStorage.getItem("bingoPlayerId");
  if (existing) return existing;
  const id = makeId("player");
  sessionStorage.setItem("bingoPlayerId", id);
  return id;
}

function validBoard(board: number[][], range: PoolRange) {
  const flat = board.flat();
  if (board.length !== 5 || board.some((row) => row.length !== 5) || flat.length !== 25) return false;
  if (flat.some((value) => !Number.isInteger(value) || value < range[0] || value > range[1])) return false;
  return new Set(flat).size === 25;
}

function randomBoard(range: PoolRange) {
  const pool = Array.from({ length: range[1] - range[0] + 1 }, (_, index) => range[0] + index);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return Array.from({ length: 5 }, (_, row) => pool.slice(row * 5, row * 5 + 5));
}

function allNumbers(range: PoolRange) {
  return Array.from({ length: range[1] - range[0] + 1 }, (_, index) => range[0] + index);
}

function lineCells(line: LineId) {
  if (line.startsWith("ROW_")) {
    const row = Number(line.slice(-1));
    return Array.from({ length: 5 }, (_, col) => [row, col] as const);
  }
  if (line.startsWith("COL_")) {
    const col = Number(line.slice(-1));
    return Array.from({ length: 5 }, (_, row) => [row, col] as const);
  }
  if (line === "DIAG_MAIN") return Array.from({ length: 5 }, (_, index) => [index, index] as const);
  return Array.from({ length: 5 }, (_, index) => [index, 4 - index] as const);
}

function evaluateBoard(board: BoardState, calledNumber: number) {
  const marked = board.marked.map((row) => [...row]);
  board.grid.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value === calledNumber) marked[rowIndex][colIndex] = true;
    });
  });

  const completed = new Set(board.completedLines);
  const newLines: LineId[] = [];
  for (const line of lineIds) {
    if (completed.has(line)) continue;
    if (lineCells(line).every(([row, col]) => marked[row][col])) {
      completed.add(line);
      newLines.push(line);
    }
  }

  return {
    board: { ...board, marked, completedLines: [...completed] },
    newLines,
  };
}

function cellLineClasses(row: number, col: number, completed: LineId[]) {
  const tags = [];
  if (completed.includes(`ROW_${row}` as LineId)) tags.push("line-row");
  if (completed.includes(`COL_${col}` as LineId)) tags.push("line-col");
  if (row === col && completed.includes("DIAG_MAIN")) tags.push("line-main");
  if (row + col === 4 && completed.includes("DIAG_ANTI")) tags.push("line-anti");
  return tags.join(" ");
}

function lineLabel(line: LineId) {
  if (line.startsWith("ROW_")) return `R${Number(line.slice(-1)) + 1}`;
  if (line.startsWith("COL_")) return `C${Number(line.slice(-1)) + 1}`;
  return line === "DIAG_MAIN" ? "D1" : "D2";
}

export default function App() {
  const [name, setName] = useState(localStorage.getItem("bingoName") || "Player");
  const [joinCode, setJoinCode] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [localPlayerId, setLocalPlayerId] = useState(getStoredPlayerId);
  const [isHost, setIsHost] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [manualGrid, setManualGrid] = useState<string[][]>(emptyManual);
  const [draftBoard, setDraftBoard] = useState<number[][]>(() => randomBoard(DEFAULT_POOL_RANGE));
  const [setupMode, setSetupMode] = useState<"random" | "manual">("random");
  const [locked, setLocked] = useState(false);
  const [turnChoices, setTurnChoices] = useState<number[]>([]);
  const [toast, setToast] = useState("");

  const peerRef = useRef<Peer | null>(null);
  const hostConnRef = useRef<DataConnection | null>(null);
  const hostStateRef = useRef<Snapshot>(initialSnapshot);
  const connectionsRef = useRef(new Map<string, DataConnection>());
  const skipTimerRef = useRef<number | null>(null);
  const localPlayerIdRef = useRef(localPlayerId);

  const me = snapshot.players.find((player) => player.id === localPlayerId);
  const amHost = isHost || Boolean(me?.isHost);
  const myBoard = snapshot.boards[localPlayerId];
  const shareLink = snapshot.roomCode ? `${window.location.origin}/join/${snapshot.roomCode}` : "";
  const remainingPool = useMemo(
    () => allNumbers(snapshot.poolRange).filter((number) => !snapshot.calledNumbers.includes(number)),
    [snapshot.calledNumbers, snapshot.poolRange],
  );
  const myTicketRemaining = useMemo(() => {
    if (!myBoard) return remainingPool;
    const remaining = new Set(remainingPool);
    return myBoard.grid.flat().filter((number) => remaining.has(number));
  }, [myBoard, remainingPool]);

  useEffect(() => {
    const joinMatch = window.location.pathname.match(/\/join\/([a-z0-9]{5})/i);
    if (joinMatch) setJoinCode(normalizeCode(joinMatch[1]));
    return () => {
      peerRef.current?.destroy();
      hostConnRef.current?.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("bingoName", name);
  }, [name]);

  useEffect(() => {
    localPlayerIdRef.current = localPlayerId;
  }, [localPlayerId]);

  function sendTo(conn: DataConnection, message: Message) {
    if (conn.open) conn.send(message);
  }

  function broadcast(message: Message) {
    connectionsRef.current.forEach((conn) => sendTo(conn, message));
  }

  function publish(next: Snapshot, extraMessages: Message[] = []) {
    hostStateRef.current = next;
    setSnapshot(next);
    for (const message of extraMessages) broadcast(message);
    broadcast({ type: "STATE_SYNC", snapshot: next });
  }

  function syncPlayerList(nextPlayers: PlayerSummary[]) {
    const next = { ...hostStateRef.current, players: nextPlayers };
    publish(next, [{ type: "PLAYER_LIST_UPDATE", players: nextPlayers }]);
  }

  function handleClientMessage(message: Message) {
    if (message.type === "JOIN_ACCEPTED") {
      localPlayerIdRef.current = message.playerId;
      setLocalPlayerId(message.playerId);
      sessionStorage.setItem("bingoPlayerId", message.playerId);
      setStatus("Joined room");
      return;
    }
    if (message.type === "STATE_SYNC") {
      setSnapshot(message.snapshot);
      setLocked(Boolean(message.snapshot.players.find((player) => player.id === localPlayerIdRef.current)?.locked));
      return;
    }
    if (message.type === "YOUR_TURN" && message.playerId === localPlayerIdRef.current) {
      setTurnChoices(message.remainingPool);
      setToast("Your turn. Pick a number.");
      return;
    }
    if (message.type === "NUMBER_CALLED") {
      setTurnChoices([]);
      setToast("");
      return;
    }
    if (message.type === "ERROR") {
      setStatus(message.message);
    }
  }

  function acceptConnection(conn: DataConnection) {
    let connectionPlayerId = "";
    conn.on("data", (raw) => {
      const message = raw as Message;
      if (message.type === "JOIN_REQUEST") {
        const current = hostStateRef.current;
        const requestedId = message.playerId || makeId("player");
        const existingCandidate = current.players.find((player) => player.id === requestedId);
        const canRestore = existingCandidate && !existingCandidate.connected && !existingCandidate.isHost;
        const acceptedId = canRestore || !existingCandidate ? requestedId : makeId("player");
        connectionPlayerId = acceptedId;
        connectionsRef.current.set(acceptedId, conn);

        const existing = current.players.find((player) => player.id === acceptedId);
        const player: PlayerSummary = {
          id: acceptedId,
          name: message.playerName.trim() || "Player",
          isHost: false,
          connected: true,
          locked: existing?.locked || false,
          lineCount: existing?.lineCount || 0,
        };
        const players = existing
          ? current.players.map((item) => (item.id === acceptedId ? player : item))
          : [...current.players, player];
        sendTo(conn, {
          type: "JOIN_ACCEPTED",
          playerId: acceptedId,
          poolRange: current.poolRange,
          players,
        });
        publish({ ...current, players }, [{ type: "PLAYER_LIST_UPDATE", players }]);
        return;
      }
      if (message.type === "BOARD_SUBMIT") handleBoardSubmit(message.playerId, message.board);
      if (message.type === "CALL_NUMBER") handleCallNumber(message.playerId, message.number);
      if (message.type === "REMATCH_REQUEST") startRematch();
    });

    conn.on("close", () => {
      if (!connectionPlayerId) return;
      markDisconnected(connectionPlayerId);
    });
    conn.on("error", () => {
      if (!connectionPlayerId) return;
      markDisconnected(connectionPlayerId);
    });
  }

  function createRoom() {
    const code = makeRoomCode();
    const playerId = getStoredPlayerId();
    setLocalPlayerId(playerId);
    setIsHost(true);
    setStatus("Opening room...");
    peerRef.current?.destroy();

    const peer = new Peer(`BINGO-${code}`);
    peerRef.current = peer;
    const hostPlayer: PlayerSummary = {
      id: playerId,
      name: name.trim() || "Host",
      isHost: true,
      connected: true,
      locked: false,
      lineCount: 0,
    };
    const next = { ...initialSnapshot, phase: "LOBBY" as Phase, roomCode: code, players: [hostPlayer] };
    hostStateRef.current = next;

    peer.on("open", () => {
      setSnapshot(next);
      setStatus("Room ready");
    });
    peer.on("connection", acceptConnection);
    peer.on("error", (error) => setStatus(error.message));
  }

  function joinRoom() {
    const code = normalizeCode(joinCode);
    if (!code) return;
    setIsHost(false);
    setStatus("Joining room...");
    peerRef.current?.destroy();
    hostConnRef.current?.close();

    const peer = new Peer();
    peerRef.current = peer;
    peer.on("open", () => {
      const conn = peer.connect(`BINGO-${code}`, { reliable: true });
      hostConnRef.current = conn;
      conn.on("open", () => {
        sendTo(conn, { type: "JOIN_REQUEST", playerName: name.trim() || "Player", playerId: localPlayerId });
      });
      conn.on("data", (raw) => handleClientMessage(raw as Message));
      conn.on("close", () => {
        setStatus("Host disconnected. Game ended.");
        setSnapshot((current) => ({ ...current, phase: "GAME_OVER", winners: [] }));
      });
      conn.on("error", (error) => setStatus(error.message));
    });
    peer.on("error", (error) => setStatus(error.message));
  }

  function setPoolRange(range: PoolRange) {
    if (!amHost || snapshot.phase !== "LOBBY") return;
    publish({ ...hostStateRef.current, poolRange: range });
    setDraftBoard(randomBoard(range));
  }

  function startBoardSetup() {
    const current = hostStateRef.current;
    if (!amHost || current.players.filter((player) => player.connected).length < 2) return;
    const players = current.players.map((player) => ({ ...player, locked: false, lineCount: 0 }));
    const next = {
      ...current,
      phase: "BOARD_SETUP" as Phase,
      players,
      boards: {},
      calledNumbers: [],
      turnOrder: [],
      currentPlayerId: null,
      history: [],
      winners: [],
    };
    setLocked(false);
    setDraftBoard(randomBoard(next.poolRange));
    setManualGrid(emptyManual());
    publish(next, [{ type: "START_BOARD_SETUP", poolRange: next.poolRange }]);
  }

  function handleBoardSubmit(playerId: string, board: number[][]) {
    const current = hostStateRef.current;
    if (!validBoard(board, current.poolRange)) {
      const conn = connectionsRef.current.get(playerId);
      if (conn) sendTo(conn, { type: "ERROR", message: "Board must contain 25 unique numbers in range." });
      return;
    }

    const players = current.players.map((player) => (player.id === playerId ? { ...player, locked: true } : player));
    const boards = {
      ...current.boards,
      [playerId]: { playerId, grid: board, marked: emptyMarks(), completedLines: [] },
    };
    const next = { ...current, players, boards };
    publish(next, [{ type: "BOARD_LOCKED", playerId }]);

    const connected = players.filter((player) => player.connected);
    if (connected.length > 0 && connected.every((player) => player.locked)) {
      beginPlaying();
    }
  }

  function submitBoard() {
    const board =
      setupMode === "random" ? draftBoard : manualGrid.map((row) => row.map((value) => Number(value)));
    if (!validBoard(board, snapshot.poolRange)) {
      setStatus("Board must contain 25 unique numbers in range.");
      return;
    }
    setLocked(true);
    if (amHost) {
      handleBoardSubmit(localPlayerId, board);
    } else if (hostConnRef.current) {
      sendTo(hostConnRef.current, { type: "BOARD_SUBMIT", playerId: localPlayerId, board });
    }
  }

  function beginPlaying() {
    const current = hostStateRef.current;
    const turnOrder = current.players.filter((player) => player.connected).map((player) => player.id);
    const currentPlayerId = turnOrder[0] || null;
    const next = { ...current, phase: "PLAYING" as Phase, turnOrder, currentPlayerId };
    publish(next, [{ type: "ALL_BOARDS_READY", turnOrder }]);
    promptTurn(next);
  }

  function promptTurn(state = hostStateRef.current) {
    if (!state.currentPlayerId || state.phase !== "PLAYING") return;
    const remaining = allNumbers(state.poolRange).filter((number) => !state.calledNumbers.includes(number));
    if (state.currentPlayerId === localPlayerId) {
      setTurnChoices(remaining);
      setToast("Your turn. Pick a number.");
    } else {
      setTurnChoices([]);
      setToast("");
      const conn = connectionsRef.current.get(state.currentPlayerId);
      if (conn) sendTo(conn, { type: "YOUR_TURN", playerId: state.currentPlayerId, remainingPool: remaining });
    }

    const currentPlayer = state.players.find((player) => player.id === state.currentPlayerId);
    if (currentPlayer && !currentPlayer.connected) {
      if (skipTimerRef.current) window.clearTimeout(skipTimerRef.current);
      skipTimerRef.current = window.setTimeout(() => skipDisconnectedTurn(state.currentPlayerId!), 5000);
    }
  }

  function skipDisconnectedTurn(playerId: string) {
    const current = hostStateRef.current;
    if (current.currentPlayerId !== playerId || current.phase !== "PLAYING") return;
    const player = current.players.find((item) => item.id === playerId);
    const nextPlayerId = nextConnectedPlayer(current);
    const history = [
      { id: makeId("history"), playerId, playerName: player?.name || "Player", number: null, text: "Turn skipped" },
      ...current.history,
    ];
    const next = { ...current, currentPlayerId: nextPlayerId, history };
    publish(next);
    promptTurn(next);
  }

  function nextConnectedPlayer(state: Snapshot) {
    if (!state.currentPlayerId || state.turnOrder.length === 0) return null;
    const start = state.turnOrder.indexOf(state.currentPlayerId);
    for (let offset = 1; offset <= state.turnOrder.length; offset += 1) {
      const id = state.turnOrder[(start + offset) % state.turnOrder.length];
      if (state.players.find((player) => player.id === id && player.connected)) return id;
    }
    return null;
  }

  function handleCallNumber(playerId: string, number: number) {
    const current = hostStateRef.current;
    const remaining = allNumbers(current.poolRange).filter((item) => !current.calledNumbers.includes(item));
    if (current.phase !== "PLAYING" || current.currentPlayerId !== playerId || !remaining.includes(number)) {
      const conn = connectionsRef.current.get(playerId);
      const message: Message = { type: "ERROR", message: "That number cannot be called right now." };
      if (playerId === localPlayerId) setStatus(message.message);
      else if (conn) sendTo(conn, message);
      promptTurn(current);
      return;
    }

    const boards: Record<string, BoardState> = {};
    const lineMessages: Message[] = [];
    const winners = new Set(current.winners);
    Object.values(current.boards).forEach((board) => {
      const result = evaluateBoard(board, number);
      boards[board.playerId] = result.board;
      if (result.newLines.length > 0) {
        const lineCount = result.board.completedLines.length;
        lineMessages.push({
          type: "LINE_UPDATE",
          playerId: board.playerId,
          completedLines: result.board.completedLines,
          lineCount,
        });
        if (lineCount >= 5) winners.add(board.playerId);
      }
    });

    const caller = current.players.find((player) => player.id === playerId);
    const calledNumbers = [...current.calledNumbers, number];
    const players = current.players.map((player) => ({
      ...player,
      lineCount: boards[player.id]?.completedLines.length || player.lineCount,
    }));
    const gameOver = winners.size > 0 || calledNumbers.length >= allNumbers(current.poolRange).length;
    const updatedBoardCount = new Set(
      lineMessages
        .filter((message): message is Extract<Message, { type: "LINE_UPDATE" }> => message.type === "LINE_UPDATE")
        .map((message) => message.playerId),
    ).size;
    const tentative = {
      ...current,
      players,
      boards,
      calledNumbers,
      winners: [...winners],
      history: [
        {
          id: makeId("history"),
          playerId,
          playerName: caller?.name || "Player",
          number,
          text: resultText(updatedBoardCount),
        },
        ...current.history,
      ],
    };
    const nextPlayerId = gameOver ? null : nextConnectedPlayer({ ...tentative, currentPlayerId: playerId });
    const next = {
      ...tentative,
      phase: gameOver ? ("GAME_OVER" as Phase) : "PLAYING",
      currentPlayerId: nextPlayerId,
    };

    const messages: Message[] = [
      { type: "NUMBER_CALLED", number, calledBy: playerId, nextPlayerId },
      ...lineMessages,
    ];
    if (gameOver) messages.push({ type: "GAME_OVER", winners: [...winners], finalBoards: boards });
    publish(next, messages);
    setTurnChoices([]);
    if (!gameOver) promptTurn(next);
  }

  function callNumber(number: number) {
    if (amHost) handleCallNumber(localPlayerId, number);
    else if (hostConnRef.current) sendTo(hostConnRef.current, { type: "CALL_NUMBER", playerId: localPlayerId, number });
  }

  function resultText(updatedBoardCount: number) {
    if (updatedBoardCount === 0) return "";
    if (updatedBoardCount > 1) {
      setToast("Multiple lines completed.");
      window.setTimeout(() => setToast(""), 2200);
    }
    return `${updatedBoardCount} board${updatedBoardCount === 1 ? "" : "s"} advanced`;
  }

  function markDisconnected(playerId: string) {
    connectionsRef.current.delete(playerId);
    const current = hostStateRef.current;
    const players = current.players.map((player) =>
      player.id === playerId ? { ...player, connected: false } : player,
    );
    publish({ ...current, players }, [{ type: "PLAYER_DISCONNECTED", playerId }]);
    if (current.currentPlayerId === playerId) promptTurn({ ...current, players });
  }

  function startRematch() {
    if (!amHost) {
      sendTo(hostConnRef.current!, { type: "REMATCH_REQUEST" });
      return;
    }
    const current = hostStateRef.current;
    const players = current.players
      .filter((player) => player.connected)
      .map((player) => ({ ...player, locked: false, lineCount: 0 }));
    const next = {
      ...current,
      phase: "BOARD_SETUP" as Phase,
      players,
      boards: {},
      calledNumbers: [],
      turnOrder: [],
      currentPlayerId: null,
      history: [],
      winners: [],
    };
    setLocked(false);
    setDraftBoard(randomBoard(next.poolRange));
    publish(next, [{ type: "START_BOARD_SETUP", poolRange: next.poolRange }]);
  }

  function leave() {
    peerRef.current?.destroy();
    hostConnRef.current?.close();
    peerRef.current = null;
    hostConnRef.current = null;
    connectionsRef.current.clear();
    setSnapshot(initialSnapshot);
    setIsHost(false);
    setLocked(false);
    setTurnChoices([]);
    setStatus("Ready");
  }

  const manualNumbers = manualGrid.flat().map((value) => Number(value));
  const manualDuplicates = manualNumbers.filter(
    (value, index) => value && manualNumbers.indexOf(value) !== index,
  );
  const selectedBoard = setupMode === "random" ? draftBoard : manualGrid.map((row) => row.map((value) => Number(value)));
  const boardReady = validBoard(selectedBoard, snapshot.poolRange);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Indian Bingo</span>
          <h1>5x5 Round-Robin Bingo</h1>
        </div>
        {snapshot.phase !== "HOME" && (
          <button className="icon-button" onClick={leave} title="Leave room">
            <LogOut size={18} />
          </button>
        )}
      </header>

      {status && <div className="status">{status}</div>}
      {toast && <div className="toast">{toast}</div>}

      {snapshot.phase === "HOME" && (
        <section className="home-grid">
          <div className="panel">
            <h2>Create or join</h2>
            <label>
              Display name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} />
            </label>
            <div className="action-row">
              <button className="primary" onClick={createRoom}>
                <Users size={18} />
                Create Room
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>Join room</h2>
            <label>
              Room code
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(normalizeCode(event.target.value))}
                placeholder="X7QRT"
                maxLength={5}
              />
            </label>
            <button className="secondary" onClick={joinRoom} disabled={joinCode.length !== 5}>
              <Share2 size={18} />
              Join Room
            </button>
          </div>
        </section>
      )}

      {snapshot.phase === "LOBBY" && (
        <section className="workspace">
          <div className="panel room-panel">
            <span className="eyebrow">Room Code</span>
            <div className="room-code">{snapshot.roomCode}</div>
            <button className="secondary" onClick={() => navigator.clipboard?.writeText(shareLink)}>
              <Copy size={18} />
              Copy Link
            </button>
          </div>

          <div className="panel">
            <h2>Players</h2>
            <PlayerList players={snapshot.players} />
            {amHost && (
              <>
                <div className="host-settings">
                  <div className="section-head">
                    <h2>Host settings</h2>
                    <strong>Board numbers: 1-{snapshot.poolRange[1]}</strong>
                  </div>
                  <label>
                    Number range preset
                    <select
                      value={`${snapshot.poolRange[0]}-${snapshot.poolRange[1]}`}
                      onChange={(event) => {
                        const [, max] = event.target.value.split("-").map(Number);
                        setPoolRange([1, max]);
                      }}
                    >
                      <option value="1-25">1 to 25</option>
                      <option value="1-50">1 to 50</option>
                      <option value="1-75">1 to 75</option>
                      <option value="1-100">1 to 100</option>
                    </select>
                  </label>
                  <label>
                    Custom highest number
                    <input
                      type="number"
                      min={25}
                      max={100}
                      value={snapshot.poolRange[1]}
                      onChange={(event) => {
                        const max = Math.max(25, Math.min(100, Number(event.target.value) || 25));
                        setPoolRange([1, max]);
                      }}
                    />
                  </label>
                </div>
                <button
                  className="primary"
                  onClick={startBoardSetup}
                  disabled={snapshot.players.filter((player) => player.connected).length < 2}
                >
                  <Play size={18} />
                  Start Game
                </button>
              </>
            )}
          </div>
        </section>
      )}

      {snapshot.phase === "BOARD_SETUP" && (
        <section className="workspace setup-layout">
          <div className="panel">
            <div className="section-head">
              <h2>Build your board</h2>
              <span>{snapshot.poolRange[0]}-{snapshot.poolRange[1]}</span>
            </div>
            <div className="segmented">
              <button className={setupMode === "random" ? "active" : ""} onClick={() => setSetupMode("random")}>
                Random
              </button>
              <button className={setupMode === "manual" ? "active" : ""} onClick={() => setSetupMode("manual")}>
                Manual
              </button>
            </div>
            {setupMode === "random" ? (
              <>
                <Board board={{ playerId: localPlayerId, grid: draftBoard, marked: emptyMarks(), completedLines: [] }} />
                <button className="secondary" onClick={() => setDraftBoard(randomBoard(snapshot.poolRange))} disabled={locked}>
                  <Dices size={18} />
                  Randomize
                </button>
              </>
            ) : (
              <div className="manual-grid">
                {manualGrid.map((row, rowIndex) =>
                  row.map((value, colIndex) => {
                    const number = Number(value);
                    const invalid =
                      value !== "" &&
                      (!Number.isInteger(number) ||
                        number < snapshot.poolRange[0] ||
                        number > snapshot.poolRange[1] ||
                        manualDuplicates.includes(number));
                    return (
                      <input
                        key={`${rowIndex}-${colIndex}`}
                        className={invalid ? "invalid" : ""}
                        value={value}
                        disabled={locked}
                        inputMode="numeric"
                        onChange={(event) => {
                          const next = manualGrid.map((manualRow) => [...manualRow]);
                          next[rowIndex][colIndex] = event.target.value.replace(/\D/g, "").slice(0, 3);
                          setManualGrid(next);
                        }}
                      />
                    );
                  }),
                )}
              </div>
            )}
            <button className="primary" onClick={submitBoard} disabled={!boardReady || locked}>
              <Check size={18} />
              {locked ? "Locked" : "Lock In"}
            </button>
          </div>

          <div className="panel">
            <h2>Waiting on</h2>
            <PlayerList players={snapshot.players} showLocks />
          </div>
        </section>
      )}

      {snapshot.phase === "PLAYING" && (
        <section className="game-layout">
          <div className="panel board-panel">
            <div className="section-head">
              <h2>Your board</h2>
              <strong>{me?.lineCount || 0} / 5 lines</strong>
            </div>
            {myBoard && (
              <Board
                board={myBoard}
                canCall={snapshot.currentPlayerId === localPlayerId}
                callableNumbers={myTicketRemaining}
                onCall={callNumber}
              />
            )}
            {myBoard && <LineTracker completed={myBoard.completedLines} />}
          </div>

          <div className="panel play-panel">
            <TurnPanel
              players={snapshot.players}
              currentPlayerId={snapshot.currentPlayerId}
              localPlayerId={localPlayerId}
              remainingPool={myTicketRemaining.filter((number) =>
                (turnChoices.length ? turnChoices : remainingPool).includes(number),
              )}
              canCall={snapshot.currentPlayerId === localPlayerId}
              onCall={callNumber}
            />
          </div>

          <aside className="side-stack">
            <div className="panel">
              <h2>Leaderboard</h2>
              <PlayerList players={[...snapshot.players].sort((a, b) => b.lineCount - a.lineCount)} />
            </div>
            <History history={snapshot.history} />
          </aside>
        </section>
      )}

      {snapshot.phase === "GAME_OVER" && (
        <section className="game-over">
          <div className="winner-band">
            <Crown size={30} />
            <h2>
              {snapshot.winners.length
                ? `${snapshot.winners.map((id) => snapshot.players.find((player) => player.id === id)?.name || "Player").join(", ")} won`
                : "Draw"}
            </h2>
          </div>
          <div className="action-row center">
            <button className="primary" onClick={startRematch}>
              <RefreshCw size={18} />
              Rematch
            </button>
            <button className="secondary" onClick={leave}>
              <LogOut size={18} />
              Leave
            </button>
          </div>
          <div className="final-grid">
            {Object.values(snapshot.boards).map((board) => (
              <div className="panel" key={board.playerId}>
                <h2>{snapshot.players.find((player) => player.id === board.playerId)?.name || "Player"}</h2>
                <Board board={board} />
                <LineTracker completed={board.completedLines} />
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function PlayerList({ players, showLocks = false }: { players: PlayerSummary[]; showLocks?: boolean }) {
  return (
    <div className="player-list">
      {players.map((player) => (
        <div className="player-row" key={player.id}>
          <span className={player.connected ? "dot online" : "dot"} />
          <span>{player.name}</span>
          {player.isHost && <small>Host</small>}
          {showLocks ? <strong>{player.locked ? "Locked" : "Open"}</strong> : <strong>{player.lineCount}/5</strong>}
        </div>
      ))}
    </div>
  );
}

function Board({
  board,
  canCall = false,
  callableNumbers = [],
  onCall,
}: {
  board: BoardState;
  canCall?: boolean;
  callableNumbers?: number[];
  onCall?: (number: number) => void;
}) {
  const callable = new Set(callableNumbers);
  return (
    <div className="bingo-board">
      {board.grid.map((row, rowIndex) =>
        row.map((value, colIndex) => {
          const canCallCell = canCall && callable.has(value) && !board.marked[rowIndex][colIndex];
          return (
            <button
              className={`cell ${board.marked[rowIndex][colIndex] ? "marked" : ""} ${canCallCell ? "callable" : ""} ${cellLineClasses(
              rowIndex,
              colIndex,
              board.completedLines,
            )}`}
              disabled={!canCallCell}
              key={`${rowIndex}-${colIndex}`}
              onClick={() => onCall?.(value)}
              title={canCallCell ? `Call ${value}` : undefined}
            >
              {value}
            </button>
          );
        }),
      )}
    </div>
  );
}

function LineTracker({ completed }: { completed: LineId[] }) {
  return (
    <div className="line-tracker">
      {lineIds.map((line) => (
        <span className={completed.includes(line) ? "complete" : ""} key={line}>
          {lineLabel(line)}
        </span>
      ))}
    </div>
  );
}

function TurnPanel({
  players,
  currentPlayerId,
  localPlayerId,
  remainingPool,
  canCall,
  onCall,
}: {
  players: PlayerSummary[];
  currentPlayerId: string | null;
  localPlayerId: string;
  remainingPool: number[];
  canCall: boolean;
  onCall: (number: number) => void;
}) {
  const current = players.find((player) => player.id === currentPlayerId);
  return (
    <>
      <div className="section-head">
        <h2>{canCall ? "Your turn" : `Waiting for ${current?.name || "next player"}`}</h2>
        <span>{remainingPool.length} left</span>
      </div>
      <div className="number-grid">
        {remainingPool.map((number) => (
          <button disabled={!canCall || localPlayerId !== currentPlayerId} onClick={() => onCall(number)} key={number}>
            {canCall && <Send size={13} />}
            {number}
          </button>
        ))}
      </div>
    </>
  );
}

function History({ history }: { history: HistoryEntry[] }) {
  return (
    <div className="panel history">
      <h2>Call history</h2>
      {history.length === 0 ? (
        <p>No calls yet.</p>
      ) : (
        history.map((entry) => (
          <div className="history-row" key={entry.id}>
            <strong>{entry.number ?? "-"}</strong>
            <span>
              {entry.playerName}
              {entry.text ? `: ${entry.text}` : ""}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
