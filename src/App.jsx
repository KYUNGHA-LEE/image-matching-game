import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { db } from "./firebase";
import { ref as dbRef, onValue, set, update, remove, push, child, get, runTransaction } from "firebase/database";

/* =========================================================================
 * 🎯 AI 이미지 배틀
 * 1단계: 학생 닉네임 입장 → 리스트1 / 선생님 이미지 업로드 → 리스트2 / [매칭] 버튼
 * 2단계: 시간 설정 → [게임시작] → 이미지 10배 복제, 화면 자동 스프레드
 *        → 다른 사람 이미지 클릭 시 내 이미지로 변경 → 1~5등 실시간 랭킹
 * =======================================================================*/

const ROOM = "default";
const T_PASS = "123456";          // 선생님 비밀번호
const TILES_PER_PLAYER = 10;      // 한 사람당 복제 타일 수
const DEFAULT_DURATION = 60;      // 기본 라운드 시간(초)
const IMG_MAX_DIM = 512;          // 업로드 이미지 최대 변 길이 (자동 압축)
const IMG_QUALITY = 0.75;         // JPEG 품질 (0~1)

/* ------------------------- DB 경로 헬퍼 ------------------------- */
const roomRef = () => dbRef(db, `rooms/${ROOM}`);
const playersRef = () => dbRef(db, `rooms/${ROOM}/players`);
const imagesRef = () => dbRef(db, `rooms/${ROOM}/images`);
const matchingsRef = () => dbRef(db, `rooms/${ROOM}/matchings`);
const tilesRef = () => dbRef(db, `rooms/${ROOM}/tiles`);
const stateRef = () => dbRef(db, `rooms/${ROOM}/state`);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ------------------------- 효과음 (Web Audio) ------------------------- */
let _audioCtx = null;
function getAudioCtx() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    return _audioCtx;
  } catch { return null; }
}
function playTone(freq = 800, duration = 0.06, vol = 0.15, type = "sine") {
  const ctx = getAudioCtx(); if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch {}
}
const sfx = {
  click: () => playTone(800, 0.05, 0.12, "sine"),       // 일반 버튼: 짧은 톡
  tile:  () => playTone(1100, 0.07, 0.15, "triangle"),  // 타일 점령: 살짝 높은 톡
  ok:    () => { playTone(660, 0.08, 0.18, "sine"); setTimeout(() => playTone(990, 0.12, 0.18, "sine"), 80); }, // 성공 도-솔
  start: () => { playTone(523, 0.1, 0.2, "triangle"); setTimeout(() => playTone(659, 0.1, 0.2, "triangle"), 110); setTimeout(() => playTone(784, 0.18, 0.2, "triangle"), 220); }, // 도미솔
  end:   () => { playTone(880, 0.15, 0.2, "sine"); setTimeout(() => playTone(660, 0.2, 0.18, "sine"), 160); }, // 종료
};

/* 이미지 파일 → 자동 리사이즈 → Base64 dataURL 변환 */
function fileToResizedDataUrl(file, maxDim = IMG_MAX_DIM, quality = IMG_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h); // 투명 배경 → 흰색 (JPEG 변환용)
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* =======================================================================
 *  Firebase 실시간 구독 훅
 * =====================================================================*/
function useRoom() {
  const [data, setData] = useState({
    state: null,
    players: {},
    images: {},
    matchings: {},
    tiles: {},
  });
  useEffect(() => {
    const unsub = onValue(roomRef(), (snap) => {
      const v = snap.val() || {};
      setData({
        state: v.state || null,
        players: v.players || {},
        images: v.images || {},
        matchings: v.matchings || {},
        tiles: v.tiles || {},
      });
    });
    return () => unsub();
  }, []);
  return data;
}

/* =======================================================================
 *  메인 컴포넌트
 * =====================================================================*/
export default function App() {
  const [mode, setMode] = useState(null); // null | "teacher" | "student"
  const [meId, setMeId] = useState(null);
  const [meName, setMeName] = useState("");

  // 학생일 때 자동 하트비트(접속 유지) 처리는 단순화 — 페이지 닫기 시 지움
  useEffect(() => {
    if (mode !== "student" || !meId) return;
    const handleBeforeUnload = () => {
      // 비동기 동작이지만 best-effort
      remove(dbRef(db, `rooms/${ROOM}/players/${meId}`));
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [mode, meId]);

  if (!mode) return <RoleSelect onPick={setMode} />;
  if (mode === "teacher") return <TeacherPanel onExit={() => setMode(null)} />;
  return (
    <StudentPanel
      meId={meId}
      meName={meName}
      onJoined={(id, name) => { setMeId(id); setMeName(name); }}
      onExit={() => {
        if (meId) remove(dbRef(db, `rooms/${ROOM}/players/${meId}`));
        setMode(null); setMeId(null); setMeName("");
      }}
    />
  );
}

/* =======================================================================
 *  역할 선택 화면
 * =====================================================================*/
function RoleSelect({ onPick }) {
  return (
    <div style={S.bg}>
      <div style={{...S.card, maxWidth: 520, textAlign: "center"}}>
        <h1 style={{margin: 0, fontSize: 32, color: "#fff"}}>🎯 AI 이미지 배틀</h1>
        <p style={{color: "#cbd5e1", marginTop: 8}}>실시간 이미지 점령 게임</p>
        <div style={{display: "flex", gap: 12, marginTop: 24, justifyContent: "center"}}>
          <button style={{...S.btn, ...S.btnPrimary, fontSize: 18, padding: "14px 28px"}}
                  onClick={() => { sfx.click(); onPick("student"); }}>
            🙋 학생으로 입장
          </button>
          <button style={{...S.btn, ...S.btnGhost, fontSize: 18, padding: "14px 28px"}}
                  onClick={() => { sfx.click(); onPick("teacher"); }}>
            🧑‍🏫 선생님으로 입장
          </button>
        </div>
      </div>
    </div>
  );
}

/* =======================================================================
 *  학생 패널
 * =====================================================================*/
function StudentPanel({ meId, meName, onJoined, onExit }) {
  const room = useRoom();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const prevPhaseRef = useRef(null);

  // phase가 바뀔 때마다 효과음 알림 (학생도 자동으로 들음)
  useEffect(() => {
    if (!meId) return;
    const phase = room.state?.phase;
    const prev = prevPhaseRef.current;
    if (phase && phase !== prev) {
      if (phase === "ready") sfx.ok();        // 매칭 완료
      if (phase === "playing") sfx.start();   // 게임 시작
      if (phase === "ended") sfx.end();       // 게임 종료
      prevPhaseRef.current = phase;
    }
  }, [room.state?.phase, meId]);

  const join = async () => {
    const n = name.trim();
    if (!n) { setError("닉네임을 입력하세요"); return; }
    if (n.length > 12) { setError("닉네임은 12자 이내"); return; }
    // 중복 검사
    const exists = Object.values(room.players).some((p) => p.name === n);
    if (exists) { setError("이미 사용 중인 닉네임입니다"); return; }
    const id = uid();
    await set(dbRef(db, `rooms/${ROOM}/players/${id}`), {
      name: n,
      joinedAt: Date.now(),
    });
    sfx.ok();
    onJoined(id, n);
  };

  // 입장 전
  if (!meId) {
    return (
      <div style={S.bg}>
        <div style={{...S.card, maxWidth: 480}}>
          <h2 style={{color: "#fff", marginTop: 0}}>🙋 학생 입장</h2>
          <p style={{color: "#cbd5e1"}}>닉네임을 입력하면 자동으로 리스트에 추가됩니다.</p>
          <input
            style={S.input}
            placeholder="닉네임 (12자 이내)"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && join()}
            autoFocus
          />
          {error && <div style={{color: "#f87171", fontSize: 13, marginTop: 8}}>{error}</div>}
          <div style={{display: "flex", gap: 8, marginTop: 16}}>
            <button style={{...S.btn, ...S.btnPrimary, flex: 1}} onClick={() => { sfx.click(); join(); }}>입장</button>
            <button style={{...S.btn, ...S.btnGhost}} onClick={() => { sfx.click(); onExit(); }}>← 뒤로</button>
          </div>
          <PlayerList players={room.players} highlight={meId} />
        </div>
      </div>
    );
  }

  // 입장 후 → 게임 상태에 따라 화면 분기
  const phase = room.state?.phase || "lobby";
  if (phase === "playing") return <GameArena room={room} meId={meId} meName={meName} onExit={onExit} />;
  if (phase === "ended")   return <ResultScreen room={room} meId={meId} onExit={onExit} />;

  // lobby 또는 ready
  const myImg = room.matchings[meId] && room.images[room.matchings[meId]];
  return (
    <div style={S.bg}>
      <div style={{...S.card, maxWidth: 600}}>
        <h2 style={{color: "#fff", marginTop: 0}}>🙋 {meName} 님 입장 완료</h2>

        {/* 매칭이 끝났으면 내 이미지를 큼지막하게 보여줌 */}
        {phase === "ready" && myImg && (
          <div style={{
            textAlign: "center", marginTop: 16, padding: 20,
            background: "rgba(251,191,36,0.08)",
            border: "2px solid #fbbf24", borderRadius: 16,
          }}>
            <div style={{color: "#fbbf24", fontSize: 18, fontWeight: 800, marginBottom: 12}}>
              ✨ 내 이미지가 매칭됐어요! ✨
            </div>
            <img
              src={myImg.dataUrl}
              alt=""
              style={{
                width: 240, height: 240, objectFit: "cover",
                borderRadius: 16, border: "4px solid #fbbf24",
                boxShadow: "0 0 30px rgba(251,191,36,0.55)",
              }}
            />
            <div style={{color: "#fff", fontSize: 14, marginTop: 14, fontWeight: 600}}>
              📝 이 이미지를 잘 기억해두세요!
            </div>
            <div style={{color: "#cbd5e1", fontSize: 12, marginTop: 4}}>
              곧 게임이 시작됩니다…
            </div>
          </div>
        )}

        {/* 매칭 전 (lobby) */}
        {phase !== "ready" && (
          <>
            <p style={{color: "#cbd5e1"}}>선생님이 게임을 시작할 때까지 기다려주세요.</p>
            <div style={{marginTop: 16, color:"#94a3b8", fontSize: 14}}>⏳ 대기 중…</div>
          </>
        )}

        <div style={{marginTop: 16}}>
          <div style={{color: "#cbd5e1", fontSize: 13, marginBottom: 6}}>
            👥 입장한 학생 ({Object.keys(room.players).length}명)
          </div>
          <PlayerList players={room.players} highlight={meId} matchings={room.matchings} images={room.images} />
        </div>

        <button style={{...S.btn, ...S.btnGhost, marginTop: 16}}
                onClick={() => { sfx.click(); onExit(); }}>나가기</button>
      </div>
    </div>
  );
}

/* =======================================================================
 *  선생님 패널
 * =====================================================================*/
function TeacherPanel({ onExit }) {
  const [authed, setAuthed] = useState(false);
  const [pwd, setPwd] = useState("");
  const [pwdError, setPwdError] = useState("");
  const room = useRoom();
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  const phase = room.state?.phase || "lobby";

  if (!authed) {
    return (
      <div style={S.bg}>
        <div style={{...S.card, maxWidth: 420}}>
          <h2 style={{color: "#fff", marginTop: 0}}>🧑‍🏫 선생님 인증</h2>
          <input
            type="password"
            style={S.input}
            placeholder="비밀번호"
            value={pwd}
            onChange={(e) => { setPwd(e.target.value); setPwdError(""); }}
            onKeyDown={(e) => e.key === "Enter" && (pwd === T_PASS ? setAuthed(true) : setPwdError("비밀번호가 틀립니다"))}
            autoFocus
          />
          {pwdError && <div style={{color: "#f87171", fontSize: 13, marginTop: 8}}>{pwdError}</div>}
          <div style={{display: "flex", gap: 8, marginTop: 16}}>
            <button style={{...S.btn, ...S.btnPrimary, flex: 1}}
              onClick={() => {
                if (pwd === T_PASS) { sfx.ok(); setAuthed(true); }
                else { sfx.click(); setPwdError("비밀번호가 틀립니다"); }
              }}>입장</button>
            <button style={{...S.btn, ...S.btnGhost}} onClick={() => { sfx.click(); onExit(); }}>← 뒤로</button>
          </div>
        </div>
      </div>
    );
  }

  /* ------- 이미지 업로드 (Base64로 DB에 직접 저장) ------- */
  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        const id = uid();
        // 자동 압축 (최대 512x512, JPEG 품질 0.75)
        const dataUrl = await fileToResizedDataUrl(file);
        await set(dbRef(db, `rooms/${ROOM}/images/${id}`), {
          dataUrl, fileName: file.name, addedAt: Date.now(),
        });
      }
    } catch (err) {
      alert("업로드 실패: " + err.message);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeImage = async (imgId) => {
    if (!confirm("이 이미지를 삭제할까요?")) return;
    try {
      await remove(dbRef(db, `rooms/${ROOM}/images/${imgId}`));
    } catch (err) { alert("삭제 실패: " + err.message); }
  };

  /* ------- 매칭 (학생 ↔ 이미지) ------- */
  const doMatching = async () => {
    const playerIds = Object.keys(room.players);
    const imageIds = Object.keys(room.images);
    if (playerIds.length === 0) { alert("입장한 학생이 없습니다"); return; }
    if (imageIds.length === 0) { alert("업로드된 이미지가 없습니다"); return; }
    // 이미지가 부족하면 순환 사용
    const shuffled = [...imageIds].sort(() => Math.random() - 0.5);
    const matchings = {};
    playerIds.forEach((pid, i) => {
      matchings[pid] = shuffled[i % shuffled.length];
    });
    await set(matchingsRef(), matchings);
    await set(stateRef(), { phase: "ready", duration });
    await remove(tilesRef()); // 이전 게임 타일 청소
    sfx.ok();
  };

  /* ------- 게임 시작 ------- */
  const startGame = async () => {
    const playerIds = Object.keys(room.players);
    const matchings = room.matchings || {};
    const matchedPlayers = playerIds.filter((pid) => matchings[pid]);
    if (matchedPlayers.length < 2) { alert("매칭된 학생이 2명 이상 필요합니다"); return; }

    // 타일 위치 계산 (그리드 + 약간의 jitter)
    const total = matchedPlayers.length * TILES_PER_PLAYER;
    const aspect = 16 / 9;
    const cols = Math.max(1, Math.round(Math.sqrt(total * aspect)));
    const rows = Math.ceil(total / cols);

    // 타일 ID들과 ownerId 배열 생성 (셔플)
    const tilesArray = [];
    matchedPlayers.forEach((pid) => {
      for (let i = 0; i < TILES_PER_PLAYER; i++) tilesArray.push(pid);
    });
    // 섞기
    for (let i = tilesArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tilesArray[i], tilesArray[j]] = [tilesArray[j], tilesArray[i]];
    }

    const tiles = {};
    tilesArray.forEach((ownerId, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      // 0~1 정규화 좌표 (각 셀의 중앙) + 약간의 jitter
      const cx = (c + 0.5) / cols;
      const cy = (r + 0.5) / rows;
      const jx = (Math.random() - 0.5) * (0.6 / cols);
      const jy = (Math.random() - 0.5) * (0.6 / rows);
      const tid = uid();
      tiles[tid] = {
        ownerId,
        x: Math.max(0.02, Math.min(0.98, cx + jx)),
        y: Math.max(0.02, Math.min(0.98, cy + jy)),
      };
    });

    const startedAt = Date.now();
    const endsAt = startedAt + duration * 1000;
    await set(tilesRef(), tiles);
    await set(stateRef(), { phase: "playing", duration, cols, rows, startedAt, endsAt });
    sfx.start();
  };

  /* ------- 게임 종료 / 리셋 ------- */
  const endGame = async () => {
    if (!confirm("게임을 종료할까요?")) return;
    const cur = (await get(stateRef())).val() || {};
    await update(stateRef(), { ...cur, phase: "ended", endedAt: Date.now() });
  };

  const fullReset = async () => {
    if (!confirm("정말 전체 초기화할까요? (학생/이미지/매칭/타일 모두 삭제)")) return;
    setBusy(true);
    try {
      await remove(roomRef());
    } catch (err) { alert("초기화 실패: " + err.message); }
    setBusy(false);
  };

  const backToLobby = async () => {
    if (!confirm("로비로 돌아갑니다 (이미지/학생은 유지)")) return;
    await remove(tilesRef());
    await remove(matchingsRef());
    await remove(stateRef());
  };

  /* ------- 게임 진행 중이면 게임 화면도 같이 표시 ------- */
  if (phase === "playing") {
    return <TeacherGameView room={room} onEnd={endGame} />;
  }
  if (phase === "ended") {
    return <TeacherResultView room={room} onBack={backToLobby} onReset={fullReset} />;
  }

  /* ------- 로비/매칭 단계 ------- */
  return (
    <div style={S.bg}>
      <div style={{...S.card, maxWidth: 980}}>
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <h2 style={{color: "#fff", margin: 0}}>🧑‍🏫 선생님 패널</h2>
          <div style={{display:"flex", gap: 8}}>
            <button style={{...S.btn, ...S.btnGhost}} onClick={fullReset}>🗑 전체 초기화</button>
            <button style={{...S.btn, ...S.btnGhost}} onClick={onExit}>나가기</button>
          </div>
        </div>

        {/* 두 리스트를 좌우로 배치 */}
        <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16}}>
          {/* 리스트 1: 학생 */}
          <div style={S.subCard}>
            <h3 style={{margin: "0 0 8px", color: "#fff"}}>📋 리스트 1 — 학생 ({Object.keys(room.players).length})</h3>
            <PlayerList players={room.players} matchings={room.matchings} images={room.images} compact />
          </div>

          {/* 리스트 2: 이미지 */}
          <div style={S.subCard}>
            <h3 style={{margin: "0 0 8px", color: "#fff"}}>🖼 리스트 2 — 이미지 ({Object.keys(room.images).length})</h3>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleUpload}
              style={{color: "#cbd5e1", marginBottom: 8}}
            />
            {busy && <div style={{color: "#fbbf24", fontSize: 13}}>업로드 중…</div>}
            <ImageList images={room.images} onRemove={removeImage} />
          </div>
        </div>

        {/* 매칭 / 시간 / 시작 */}
        <div style={{...S.subCard, marginTop: 16}}>
          <div style={{display:"flex", flexWrap:"wrap", gap: 12, alignItems:"center"}}>
            <button
              style={{...S.btn, ...S.btnPrimary}}
              onClick={doMatching}
              disabled={busy}
            >🎲 매칭</button>

            <div style={{color: "#cbd5e1"}}>제한 시간:</div>
            <input
              type="number"
              min={10}
              max={600}
              value={duration}
              onChange={(e) => setDuration(Math.max(10, Math.min(600, parseInt(e.target.value || "60"))))}
              style={{...S.input, width: 90}}
            />
            <div style={{color: "#cbd5e1"}}>초</div>

            <button
              style={{...S.btn, ...S.btnSuccess}}
              onClick={startGame}
              disabled={phase !== "ready" || busy}
            >▶ 게임 시작</button>

            <span style={{color: phase === "ready" ? "#22c55e" : "#94a3b8", fontSize: 13}}>
              상태: {phase === "ready" ? "✅ 매칭 완료 (시작 가능)" : "🟡 대기 중 (먼저 매칭하세요)"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =======================================================================
 *  공용 — 학생 리스트
 * =====================================================================*/
function PlayerList({ players, highlight, compact, matchings, images }) {
  const arr = Object.entries(players).sort((a,b) => (a[1].joinedAt||0) - (b[1].joinedAt||0));
  if (!arr.length) return <div style={{color: "#94a3b8", fontSize: 13}}>아직 입장한 학생이 없습니다.</div>;
  return (
    <div style={{display: "flex", flexWrap: "wrap", gap: 6, marginTop: compact ? 0 : 12}}>
      {arr.map(([pid, p]) => {
        const matchedImg = matchings && images ? images[matchings[pid]] : null;
        return (
          <div key={pid}
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              background: pid === highlight ? "#3b82f6" : "#1e293b",
              color: "#fff",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid #334155",
            }}>
            {matchedImg && (
              <img src={matchedImg.dataUrl} alt="" style={{width: 22, height: 22, objectFit: "cover", borderRadius: 4}} />
            )}
            <span>{p.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/* =======================================================================
 *  공용 — 이미지 리스트 (선생님용)
 * =====================================================================*/
function ImageList({ images, onRemove }) {
  const arr = Object.entries(images).sort((a,b) => (a[1].addedAt||0) - (b[1].addedAt||0));
  if (!arr.length) return <div style={{color: "#94a3b8", fontSize: 13}}>아직 업로드된 이미지가 없습니다.</div>;
  return (
    <div style={{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 8}}>
      {arr.map(([id, img]) => (
        <div key={id} style={{position: "relative"}}>
          <img src={img.dataUrl} alt={img.fileName}
               style={{width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: 6, border: "1px solid #334155"}} />
          <button
            onClick={() => onRemove(id)}
            style={{
              position: "absolute", top: 2, right: 2, width: 22, height: 22,
              borderRadius: 11, border: "none", background: "rgba(220,38,38,0.9)", color:"#fff", cursor:"pointer",
              fontSize: 13, lineHeight: "20px",
            }}>×</button>
          <div style={{fontSize: 10, color: "#cbd5e1", textAlign: "center", marginTop: 2,
                       overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}>
            {img.fileName}
          </div>
        </div>
      ))}
    </div>
  );
}

/* =======================================================================
 *  게임 아레나 (학생 화면)
 * =====================================================================*/
function GameArena({ room, meId, meName, onExit }) {
  return <ArenaCore room={room} meId={meId} meName={meName} onExit={onExit} isTeacher={false} />;
}
function TeacherGameView({ room, onEnd }) {
  return (
    <div style={S.bg}>
      <ArenaCore room={room} meId={null} meName="선생님" isTeacher={true} onEnd={onEnd} />
    </div>
  );
}

function ArenaCore({ room, meId, meName, isTeacher, onExit, onEnd }) {
  const { state, players, images, matchings, tiles } = room;
  const arenaRef = useRef(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });

  // 화면 크기 측정
  useEffect(() => {
    const upd = () => {
      const el = arenaRef.current;
      if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
    };
    upd();
    window.addEventListener("resize", upd);
    return () => window.removeEventListener("resize", upd);
  }, []);

  // 남은 시간
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, Math.ceil(((state?.endsAt || 0) - now) / 1000));

  // 시간 종료 → 선생님이 자동으로 ended 전환
  useEffect(() => {
    if (!isTeacher) return;
    if (state?.phase === "playing" && state?.endsAt && now >= state.endsAt) {
      update(stateRef(), { phase: "ended", endedAt: Date.now() });
    }
  }, [isTeacher, state, now]);

  // 점수 계산
  const scores = useMemo(() => {
    const cnt = {};
    Object.values(tiles).forEach(t => {
      cnt[t.ownerId] = (cnt[t.ownerId] || 0) + 1;
    });
    return cnt;
  }, [tiles]);

  const ranking = useMemo(() => {
    return Object.entries(scores)
      .map(([pid, n]) => ({ pid, n, name: players[pid]?.name || "(나감)" }))
      .sort((a,b) => b.n - a.n);
  }, [scores, players]);

  // 타일 클릭 → 점령
  const onTileClick = useCallback(async (tileId, currentOwner) => {
    if (isTeacher) return;
    if (state?.phase !== "playing") return;
    if (currentOwner === meId) return; // 내 타일은 클릭 무시
    if (!matchings[meId]) return;       // 나에게 매칭된 이미지가 없으면 무시
    sfx.tile();
    try {
      // 트랜잭션: 다른 사람이 동시에 점령했어도 last-writer-wins
      await update(dbRef(db, `rooms/${ROOM}/tiles/${tileId}`), { ownerId: meId });
    } catch (e) { /* ignore */ }
  }, [isTeacher, state, meId, matchings]);

  const tileEntries = Object.entries(tiles);

  // 타일 크기 (그리드 셀 기준)
  const cols = state?.cols || 10;
  const rows = state?.rows || 10;
  const cellW = size.w / cols;
  const cellH = size.h / rows;
  const tileW = Math.max(36, Math.min(140, cellW * 0.85));
  const tileH = Math.max(36, Math.min(140, cellH * 0.85));

  return (
    <div style={{...S.bg, padding: 0}}>
      {/* 상단 바 */}
      <div style={{display: "flex", justifyContent: "space-between", alignItems: "center",
                   padding: "8px 16px", background: "#0b1224", borderBottom: "1px solid #1e293b"}}>
        <div style={{display:"flex", gap: 12, alignItems:"center"}}>
          <span style={{color: "#fff", fontWeight: 700}}>🎯 AI 이미지 배틀</span>
          {!isTeacher && <span style={{color:"#cbd5e1", fontSize: 13}}>나: {meName}</span>}
          {!isTeacher && matchings[meId] && images[matchings[meId]] && (
            <img src={images[matchings[meId]].dataUrl} alt=""
                 style={{width: 28, height: 28, objectFit: "cover", borderRadius: 6, border: "2px solid #fbbf24"}} />
          )}
        </div>
        <div style={{display:"flex", gap: 12, alignItems:"center"}}>
          <span style={{
            color: remaining <= 10 ? "#f87171" : "#fbbf24",
            fontWeight: 800, fontSize: 22, fontVariantNumeric: "tabular-nums",
          }}>⏱ {remaining}s</span>
          {isTeacher
            ? <button style={{...S.btn, ...S.btnGhost}} onClick={onEnd}>⏹ 강제 종료</button>
            : <button style={{...S.btn, ...S.btnGhost}} onClick={onExit}>나가기</button>}
        </div>
      </div>

      {/* 게임 영역 */}
      <div ref={arenaRef}
           style={{position: "relative", width: "100%", height: "calc(100vh - 56px)", overflow: "hidden"}}>
        {tileEntries.map(([tid, t]) => {
          const imgId = matchings[t.ownerId];
          const img = imgId ? images[imgId] : null;
          if (!img) return null;
          const left = t.x * size.w - tileW / 2;
          const top  = t.y * size.h - tileH / 2;
          const mine = t.ownerId === meId;
          return (
            <img
              key={tid}
              src={img.dataUrl}
              alt=""
              onClick={() => onTileClick(tid, t.ownerId)}
              style={{
                position: "absolute",
                left, top, width: tileW, height: tileH,
                objectFit: "cover",
                borderRadius: 8,
                border: mine ? "3px solid #fbbf24" : "2px solid #1e293b",
                boxShadow: mine ? "0 0 12px rgba(251,191,36,0.6)" : "0 2px 6px rgba(0,0,0,0.6)",
                cursor: (isTeacher || mine || state?.phase !== "playing") ? "default" : "pointer",
                transition: "transform 0.15s, border 0.15s",
                userSelect: "none",
              }}
              draggable={false}
            />
          );
        })}

        {/* 좌상단 랭킹 패널 */}
        <RankingPanel ranking={ranking} meId={meId} matchings={matchings} images={images} />
      </div>
    </div>
  );
}

/* =======================================================================
 *  실시간 랭킹 (게임 중)
 * =====================================================================*/
function RankingPanel({ ranking, meId, matchings, images }) {
  const top5 = ranking.slice(0, 5);
  return (
    <div style={{
      position: "absolute", top: 12, left: 12,
      background: "rgba(15,23,42,0.85)", padding: 12, borderRadius: 12,
      border: "1px solid #334155", color: "#fff", minWidth: 200,
      backdropFilter: "blur(4px)",
    }}>
      <div style={{fontWeight: 700, marginBottom: 6, fontSize: 14}}>🏆 실시간 순위</div>
      {top5.length === 0 && <div style={{color:"#94a3b8", fontSize: 12}}>아직 점수 없음</div>}
      {top5.map((r, i) => {
        const img = images[matchings[r.pid]];
        return (
          <div key={r.pid} style={{
            display:"flex", alignItems:"center", gap: 6, padding: "3px 0",
            color: r.pid === meId ? "#fbbf24" : "#fff", fontWeight: r.pid === meId ? 800 : 500,
            fontSize: 13,
          }}>
            <span style={{width: 18}}>{["🥇","🥈","🥉","4️⃣","5️⃣"][i]}</span>
            {img && <img src={img.dataUrl} alt="" style={{width: 18, height: 18, objectFit:"cover", borderRadius: 4}} />}
            <span style={{flex: 1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{r.name}</span>
            <span style={{fontVariantNumeric:"tabular-nums"}}>{r.n}</span>
          </div>
        );
      })}
    </div>
  );
}

/* =======================================================================
 *  결과 화면
 * =====================================================================*/
function ResultScreen({ room, meId, onExit }) {
  const { players, tiles, matchings, images } = room;
  const cnt = {};
  Object.values(tiles).forEach(t => { cnt[t.ownerId] = (cnt[t.ownerId] || 0) + 1; });
  const ranking = Object.entries(cnt)
    .map(([pid, n]) => ({ pid, n, name: players[pid]?.name || "(나감)" }))
    .sort((a,b) => b.n - a.n);
  return (
    <div style={S.bg}>
      <div style={{...S.card, maxWidth: 600}}>
        <h2 style={{color: "#fff", margin: 0}}>🏆 게임 종료!</h2>
        <p style={{color: "#cbd5e1"}}>최종 순위입니다.</p>
        <Podium ranking={ranking} meId={meId} matchings={matchings} images={images} />
        <button style={{...S.btn, ...S.btnGhost, marginTop: 16}} onClick={onExit}>나가기</button>
      </div>
    </div>
  );
}
function TeacherResultView({ room, onBack, onReset }) {
  const { players, tiles, matchings, images } = room;
  const cnt = {};
  Object.values(tiles).forEach(t => { cnt[t.ownerId] = (cnt[t.ownerId] || 0) + 1; });
  const ranking = Object.entries(cnt)
    .map(([pid, n]) => ({ pid, n, name: players[pid]?.name || "(나감)" }))
    .sort((a,b) => b.n - a.n);
  return (
    <div style={S.bg}>
      <div style={{...S.card, maxWidth: 700}}>
        <h2 style={{color: "#fff", margin: 0}}>🏆 게임 종료 — 결과</h2>
        <Podium ranking={ranking} matchings={matchings} images={images} />
        <div style={{display:"flex", gap: 8, marginTop: 16}}>
          <button style={{...S.btn, ...S.btnPrimary}} onClick={onBack}>↩ 로비로</button>
          <button style={{...S.btn, ...S.btnGhost}} onClick={onReset}>🗑 전체 초기화</button>
        </div>
      </div>
    </div>
  );
}

function Podium({ ranking, meId, matchings, images }) {
  const top5 = ranking.slice(0, 5);
  if (!top5.length) return <div style={{color:"#94a3b8"}}>아무도 점수가 없습니다.</div>;
  const medals = ["🥇","🥈","🥉","4️⃣","5️⃣"];
  return (
    <div style={{display:"flex", flexDirection:"column", gap: 8, marginTop: 16}}>
      {top5.map((r, i) => {
        const img = images[matchings[r.pid]];
        const big = i === 0;
        return (
          <div key={r.pid} style={{
            display:"flex", alignItems:"center", gap: 12,
            padding: big ? "12px 16px" : "8px 12px",
            background: r.pid === meId ? "rgba(251,191,36,0.15)" : "#1e293b",
            border: big ? "2px solid #fbbf24" : "1px solid #334155",
            borderRadius: 12,
            color: "#fff",
          }}>
            <span style={{fontSize: big ? 32 : 22}}>{medals[i]}</span>
            {img && <img src={img.dataUrl} alt="" style={{
              width: big ? 52 : 36, height: big ? 52 : 36,
              objectFit:"cover", borderRadius: 8, border: "1px solid #334155",
            }}/>}
            <span style={{flex: 1, fontSize: big ? 22 : 16, fontWeight: 700}}>{r.name}</span>
            <span style={{fontSize: big ? 26 : 18, fontWeight: 800, color: "#fbbf24",
                          fontVariantNumeric:"tabular-nums"}}>{r.n}</span>
          </div>
        );
      })}
    </div>
  );
}

/* =======================================================================
 *  스타일
 * =====================================================================*/
const S = {
  bg: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #0f172a 0%, #1e293b 100%)",
    padding: 24,
    boxSizing: "border-box",
    fontFamily: "system-ui, -apple-system, 'Noto Sans KR', sans-serif",
  },
  card: {
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 16,
    padding: 24,
    boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
    margin: "40px auto",
  },
  subCard: {
    background: "#0b1224",
    border: "1px solid #334155",
    borderRadius: 12,
    padding: 14,
  },
  input: {
    background: "#0b1224",
    color: "#fff",
    border: "1px solid #334155",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 16,
    width: "100%",
    boxSizing: "border-box",
    outline: "none",
  },
  btn: {
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    transition: "transform 0.1s, opacity 0.1s",
  },
  btnPrimary: { background: "#3b82f6", color: "#fff" },
  btnSuccess: { background: "#22c55e", color: "#fff" },
  btnGhost:   { background: "#334155", color: "#fff" },
};
