# 5×5 Bingo (Indian Variant, Round-Robin Caller) — Build Spec

## 1. Summary

A real-time multiplayer Bingo game for the browser. Players join a shared room, fill a 5×5 board with unique numbers (random or manual), then take turns calling numbers in round-robin order. The first player to complete **5 distinct lines** (out of 12 possible: 5 rows, 5 columns, 2 diagonals) wins.

**No backend.** All networking is peer-to-peer via **PeerJS**. One player's browser acts as the **authoritative host**; all other players are clients that send inputs to the host and render state the host broadcasts back.

**Stack:** React (web app). PeerJS for networking. No server, no database — everything lives in browser memory for the session.

---

## 2. Assumptions to Confirm (flagged explicitly — please review)

These fill gaps in the original rules and should be treated as defaults, not locked-in decisions:

1. **Turn/calling mechanic:** On a player's turn, *they* choose any number from the pool of numbers not yet called (not a random draw), and that becomes the "called number" for everyone — same as an auctioneer. If this should instead be "random number auto-assigned on your turn," that's a small change to the turn-resolution logic (see §7).
2. **Number pool range:** Default 1–100, host-configurable at room creation (e.g., 1–50, 1–75, 1–100).
3. **Board fill range constraint:** Each player's 25 numbers must be unique *within their own board* and fall within the host-chosen pool range. Boards may overlap across players (per original spec).
4. **Turn order:** Fixed at game start based on join order; does not change during the game (i.e., it's not re-randomized each round).
5. **Skipped/disconnected players:** If a player disconnects, their turn is auto-skipped after a timeout (see §9).
6. **Manual board entry validation:** If a player chooses manual entry, the UI blocks game start until their board has exactly 25 unique valid numbers.

If any of these are wrong, flag it — everything else in this spec is written assuming these hold.

---

## 3. Game Phases (State Machine)

```
LOBBY → BOARD_SETUP → PLAYING → GAME_OVER
```

- **LOBBY**: Host creates room, shares room code/link. Players join, see each other's names/avatars, host sets number pool range. Host starts the game when ready (min 2 players).
- **BOARD_SETUP**: Every player fills their board (random-generate or manual entry). Game cannot proceed to PLAYING until all connected players confirm their board is valid and locked in.
- **PLAYING**: Turn-based number calling loop runs until a win condition is met.
- **GAME_OVER**: Winner(s) displayed, final boards shown with all completed lines highlighted. Option to rematch (returns to BOARD_SETUP with same room/players) or leave.

---

## 4. Networking Architecture (PeerJS, No Backend)

### 4.1 Topology: Host-Authoritative Star

- The player who creates the room is the **Host**. Their PeerJS `Peer` ID becomes the room code (or a short room code maps to it — see §4.2).
- All other players (**Clients**) open a PeerJS `DataConnection` directly to the Host. It is a **star topology**, not a mesh — clients do not connect to each other directly.
- The **Host holds the authoritative game state**: full turn order, whose turn it is, which numbers have been called, and each player's board + marked cells + line count.
- Clients hold a **local copy** of state for rendering, but always defer to the Host's broadcasts as truth. Clients never compute win conditions for other players — only the Host's tally counts.

### 4.2 Room Codes

- PeerJS peer IDs are long/ugly for sharing. Generate a short human-friendly room code (e.g., 5-character alphanumeric, like `X7QRT`) at host creation time, and initialize the underlying PeerJS `Peer` with that code directly as its ID (`new Peer('BINGO-X7QRT')`), prefixed to avoid collisions with other apps on the public PeerJS cloud broker.
- Joining players enter the room code, which client-side reconstructs the full peer ID (`BINGO-` + code) and connects.
- Also generate a shareable join link (`https://yourapp.com/join/X7QRT`) that pre-fills the code.

### 4.3 Message Protocol

Define a single typed message envelope sent over PeerJS `DataConnection.send()`:

```ts
type Message =
  | { type: 'JOIN_REQUEST'; playerName: string }
  | { type: 'JOIN_ACCEPTED'; playerId: string; poolRange: [number, number]; players: PlayerSummary[] }
  | { type: 'PLAYER_LIST_UPDATE'; players: PlayerSummary[] }
  | { type: 'START_BOARD_SETUP'; poolRange: [number, number] }
  | { type: 'BOARD_SUBMIT'; playerId: string; board: number[][] } // client -> host
  | { type: 'BOARD_LOCKED'; playerId: string } // host -> all, ack
  | { type: 'ALL_BOARDS_READY'; turnOrder: string[] } // host -> all, game begins
  | { type: 'YOUR_TURN'; playerId: string; remainingPool: number[] } // host -> current player only
  | { type: 'CALL_NUMBER'; playerId: string; number: number } // client -> host (only valid if it's their turn)
  | { type: 'NUMBER_CALLED'; number: number; calledBy: string; nextPlayerId: string } // host -> all
  | { type: 'LINE_UPDATE'; playerId: string; completedLines: LineId[]; lineCount: number } // host -> all
  | { type: 'GAME_OVER'; winners: string[]; finalBoards: Record<string, BoardState> }
  | { type: 'PLAYER_DISCONNECTED'; playerId: string }
  | { type: 'REMATCH_REQUEST' }
  | { type: 'ERROR'; message: string };
```

- Every state-changing action from a client is a **request**; the Host validates it, updates authoritative state, and **broadcasts the result** to all clients (including a state echo back to the sender). Clients never apply their own optimistic state changes for turn actions — wait for Host confirmation to avoid desync.

### 4.4 Reconnection & Disconnection Handling

- If a **client disconnects**: Host detects via PeerJS `connection.on('close')`/`error`. Host marks player as `disconnected` in state, broadcasts `PLAYER_DISCONNECTED`, and if it was their turn, auto-skips per §9. Their board and line progress are preserved in case they rejoin.
- If a client's browser refreshes/reopens the same room code, allow rejoin: client reconnects, sends `JOIN_REQUEST` with a persisted local `playerId` (stored in `sessionStorage`) rather than a new random one, and Host restores their prior state instead of treating them as new.
- If the **Host disconnects**: since there's no backend, the game cannot continue — there is no automatic host migration in v1. Show all clients a "Host disconnected, game ended" screen. (Optional stretch goal, not required for v1: promote the next-joined client to Host and have them re-broadcast state — call this out as a "nice to have" if time permits, not a blocker.)

---

## 5. Board Setup

### 5.1 Random Generation
- Client requests "Randomize" — generate 25 unique integers from the host-set pool range, shuffle into a 5×5 grid, display for review. Player can re-randomize before locking in.

### 5.2 Manual Entry
- 5×5 grid of empty inputs. Validate on the fly:
  - Value must be an integer within `[poolMin, poolMax]`.
  - No duplicate values across the 25 cells (highlight duplicates in red).
  - "Lock In" button disabled until all 25 cells are filled and valid.

### 5.3 Submission
- On lock-in, client sends `BOARD_SUBMIT` to Host with their board. Host validates independently (never trust client validation alone — re-check range/uniqueness server-side, i.e. host-side) and stores it.
- Host broadcasts `BOARD_LOCKED` so all players see a lobby-style "waiting on: Player X, Player Y..." list.
- When all connected players have locked boards, Host computes turn order (join order) and sends `ALL_BOARDS_READY`, transitioning everyone to PLAYING.

---

## 6. Board & Line Data Model

```ts
type BoardState = {
  playerId: string;
  grid: number[][]; // 5x5, grid[row][col]
  marked: boolean[][]; // 5x5, parallel to grid
  completedLines: Set<LineId>; // e.g. 'ROW_0', 'COL_3', 'DIAG_MAIN', 'DIAG_ANTI'
};

type LineId =
  | 'ROW_0' | 'ROW_1' | 'ROW_2' | 'ROW_3' | 'ROW_4'
  | 'COL_0' | 'COL_1' | 'COL_2' | 'COL_3' | 'COL_4'
  | 'DIAG_MAIN' | 'DIAG_ANTI';
```

### 6.1 Line Definitions (fixed cell-index sets)
- `ROW_r` = all cells where `row === r`
- `COL_c` = all cells where `col === c`
- `DIAG_MAIN` = cells where `row === col` (0,0 / 1,1 / 2,2 / 3,3 / 4,4)
- `DIAG_ANTI` = cells where `row + col === 4` (0,4 / 1,3 / 2,2 / 3,1 / 4,0)

### 6.2 Line-Check Algorithm (runs Host-side after every mark)
On every `NUMBER_CALLED` event, for **each player who has that number on their board**:
1. Mark the cell.
2. Re-evaluate all 12 lines: for each `LineId` not already in `completedLines`, check if all 5 cells in that line are marked.
3. Any newly-fully-marked line is added to `completedLines` (this naturally implements "only counted once" — a line already in the set is skipped, never re-added, never re-scored, even if it stays visually complete).
4. If one call completes multiple lines at once (e.g., last cell shared by 2 lines), add all of them in the same pass — `lineCount` can jump by more than 1 in a single turn.
5. `lineCount = completedLines.size`. Broadcast `LINE_UPDATE` for that player.
6. If `lineCount >= 5`, that player is added to a `winners` list for this round.

### 6.3 Win Check Timing
- Win checks happen **after every single call is fully processed for all players** (not just the calling player — anyone's board can complete lines from any called number, since they didn't have to be the caller to have that number).
- If, after processing a call, one or more players have `lineCount >= 5`, the Host immediately broadcasts `GAME_OVER` with **all** such players listed as winners (simultaneous multi-winner support, per spec).

---

## 7. Turn / Calling Loop

1. Host maintains `turnOrder: string[]` (player IDs, fixed at game start) and `currentTurnIndex`.
2. Host sends `YOUR_TURN` to the current player only, including the current `remainingPool` (all numbers in range not yet called).
3. That player's client UI shows a number picker (grid or searchable list of remaining numbers) and sends back `CALL_NUMBER` with their chosen number.
4. Host validates: is it actually this player's turn, and is the number still in the remaining pool? Reject with `ERROR` and re-prompt if not (defends against latency/double-submits).
5. Host marks the number as called, runs the line-check (§6.2) for every player's board, and broadcasts `NUMBER_CALLED` (with `nextPlayerId`) plus any `LINE_UPDATE`s.
6. If no winner yet, advance `currentTurnIndex` to the next **connected** player (skip disconnected ones — see §9), and repeat from step 2.
7. If the number pool is exhausted with no winner (edge case, more likely with a smaller range like 1–50), end the game as a **draw** — no line was ever fully completed by anyone with 5+ lines.

*(If assumption #1 in §2 is wrong and numbers should instead be randomly drawn rather than player-picked, step 3 changes to: Host auto-picks a random number from `remainingPool` the moment it becomes that player's turn, and announces it as "called by Player X" without waiting for input — everything else in this loop stays the same.)*

---

## 8. UI / UX Requirements

### 8.1 Screens
- **Home/Landing**: "Create Room" / "Join Room" (code input).
- **Lobby**: Room code + shareable link prominently displayed, player list with connection status dots, pool-range selector (host only), "Start Game" button (host only, disabled below 2 players).
- **Board Setup**: Toggle between Random / Manual, 5×5 grid editor, "Lock In" button, waiting-on-others list once locked.
- **Game Board**: 
  - Player's own 5×5 grid with marked cells visually distinct (e.g., filled circle/highlight).
  - Running line count, e.g. "3 / 5 lines", with the 12 possible lines shown as a small icon tracker (rows/cols/diagonals) that light up as completed.
  - Turn indicator: "Your turn — pick a number" or "Waiting for [Player]'s turn."
  - Number picker: remaining numbers grid, called numbers greyed out/removed.
  - Call history log (scrollable list of "Player X called 47").
  - Opponent list with each opponent's current line count (mini-leaderboard), so people can see who's close to winning.
- **Game Over**: Winner(s) banner, all players' final boards shown with completed lines highlighted, "Rematch" and "Leave" buttons.

### 8.2 Visual notes
- Highlight the specific cells forming each completed line distinctly (e.g., colored border matching a legend) so multi-line overlaps (shared cells) are visually clear.
- Make it obvious in real time when a single call completes multiple lines at once — e.g., a brief animation or toast: "Double line! Rows 2 & 4 complete."

---

## 9. Disconnection / Turn-Skip Handling

- Each client sends periodic pings or relies on PeerJS's built-in connection events to signal liveness to the Host.
- If it becomes a disconnected player's turn, Host waits a short grace period (e.g., 5 seconds) for reconnection, then auto-skips to the next connected player and logs "Player X's turn skipped (disconnected)."
- A reconnected player resumes receiving turns in their original `turnOrder` position on their next scheduled turn.
- If a non-current-turn player disconnects mid-game, nothing needs to happen immediately beyond marking their status — they simply get skipped when their turn comes up if still disconnected.

---

## 10. Anti-Cheat / Validation Notes (Host-side)

Since clients are just other players' browsers, the Host must not trust client-submitted data blindly:
- Re-validate board submissions (range, uniqueness, 25 cells) Host-side even though the client also validates.
- Re-validate that a `CALL_NUMBER` message only comes from the player whose turn it currently is, and that the number hasn't already been called.
- Compute all line completions and win conditions **only on the Host**; clients render whatever the Host broadcasts, never self-declare a win locally.

---

## 11. Non-Functional Requirements

- Pure client-side React app, deployable as a static site (no server/runtime dependency beyond PeerJS's public signaling broker, or optionally a self-hosted PeerServer if the public broker proves unreliable — flag this as a config option, not a hard requirement).
- No persistence beyond the current session (refresh = rejoin via room code + local `playerId`, not a full save/load system).
- Should work with at least 2–8 players in a room (soft cap, configurable).
- Responsive layout — usable on both desktop and mobile browsers.

---

## 12. Out of Scope (v1)

- Host migration on host disconnect (noted as optional stretch in §4.4).
- Spectator mode.
- Persistent accounts, stats, or history across sessions.
- Chat (can be added later as a simple `Message` type extension if desired).