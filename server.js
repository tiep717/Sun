const Fastify = require("fastify");
const cors = require("@fastify/cors");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// Token này vẫn cần được làm mới định kỳ, nhưng không phải là nguyên nhân gây lỗi 403
const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiJhcGlzdW53aW52YyIsImJvdCI6MCwiaXNNZXJjaGFudCI6ZmFsc2UsInZlcmlmaWVkQmFua0FjY291bnQiOmZhbHNlLCJwbGF5RXZlbnRMb2JieSI6ZmFsc2UsImN1c3RvbWVySWQiOjI3NjQ3ODE3MywiYWZmSWQiOiJkOTNkM2Q4NC1mMDY5LTRiM2YtOGRhYy1iNDcxNmE4MTIxNDMiLCJiYW5uZWQiOmZhbHNlLCJicmFuZCI6InN1bi53aW4iLCJ0aW1lc3RhbXAiOjE3NTM0NDM3MjM2NjIsImxvY2tHYW1lcyI6W10sImFtb3VudCI6MCwibG9ja0NoYXQiOmZhbHNlLCJwaG9uZVZlcmlmaWVkIjpmYWxzZSwiaXBBZGRyZXNzIjoiMjAwMTplZTA6NTcwODo3NzAwOjhhZjM6YWJkMTpmZTJhOmM2MmMiLCJtdXRlIjpmYWxzZSwiYXZhdGFyIjoiaHR0cHM6Ly9pbWFnZXMuc3dpbnNob3AubmV0L2ltYWdlcy9hdmF0YXIvYXZhdGFyXzIwLnBuZyIsInBsYXRmb3JtSWQiOjUsInVzZXJJZCI6ImQ5M2QzZDg0LWYwNjktNGIzZi04ZGFjLWI0NzE2YTgxMjE0MyIsInJlZ1RpbWUiOjE3NTIwNDU4OTMyOTIsInBob25lIjoiIiwiZGVwb3NpdCI6ZmFsc2UsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.a-KRvIGfMqxtBq3WenudxP8pFx7mxj33iIZm-AklInk";

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;

// ==================================================================
// LOGIC DỰ ĐOÁN V9 - LOGIC DỰ PHÒNG NÂNG CAO
// ==================================================================
const detectors = [
    {
        name: "Cầu Bệt",
        needs: "tx",
        detect: (history) => {
            if (history.length < 3) return null;
            const last = history[0];
            let streak = 0;
            for (const item of history) {
                if (item === last) streak++;
                else break;
            }
            if (streak >= 3) {
                return { prediction: last, confidence: Math.min(10, 3 + streak) };
            }
            return null;
        }
    },
    {
        name: "Cầu 1-1 (Nâng cao)",
        needs: "tx",
        detect: (history) => {
            if (history.length < 4) return null;
            let streak = 0;
            for (let i = 0; i < history.length - 1; i++) {
                if (history[i] !== history[i+1]) {
                    streak++;
                } else {
                    break;
                }
            }
            streak++;
            if (streak >= 4) {
                return { prediction: history[1], confidence: Math.min(10, 4 + streak) };
            }
            return null;
        }
    },
    {
        name: "Cầu 2-2 (Nâng cao)",
        needs: "tx",
        detect: (history) => {
            if (history.length < 4) return null;
            let streak = 0;
            for (let i = 0; i < history.length - 3; i += 2) {
                if (history[i] === history[i+1] && history[i+1] !== history[i+2] && history[i+2] === history[i+3]) {
                    streak += 2;
                } else {
                    break;
                }
            }
            if (history.length > streak + 1 && history[streak] === history[streak+1]) {
                streak +=2;
            }

            if (streak >= 4) {
                 return { prediction: history[0], confidence: Math.min(10, 4 + streak) };
            }
            return null;
        }
    },
    {
        name: "Cầu Lặp Khối",
        needs: "tx",
        detect: (history) => {
            if (history.length < 6) return null;
            const block1 = history.slice(0, 3).join('');
            const block2 = history.slice(3, 6).join('');
            if (block1 === block2) {
                return { prediction: history[2], confidence: 9 };
            }
            return null;
        }
    },
    {
        name: "Phân tích Chuyển tiếp",
        needs: "tx",
        detect: (history) => {
            if (history.length < 20) return null;
            const lastResult = history[0];
            const transitions = { T: { T: 0, X: 0 }, X: { T: 0, X: 0 } };

            for (let i = 0; i < history.length - 1; i++) {
                const current = history[i];
                const next = history[i+1];
                if (transitions[next]) {
                    transitions[next][current]++;
                }
            }
            
            const possibilities = transitions[lastResult];
            const totalTransitions = possibilities.T + possibilities.X;

            if (totalTransitions < 5) return null;

            const difference = Math.abs(possibilities.T - possibilities.X);
            if (difference / totalTransitions > 0.3) {
                const prediction = possibilities.T > possibilities.X ? 'T' : 'X';
                const confidence = Math.min(10, 2 + difference);
                return { prediction, confidence };
            }

            return null;
        }
    },
    {
        name: "Phân tích Vị Xúc Xắc (Cặp)",
        needs: "full",
        detect: (fullHistory) => {
            if (fullHistory.length < 1) return null;
            const { d1, d2, d3 } = fullHistory[0];

            if (d1 === d2 || d1 === d3 || d2 === d3) {
                const currentResult = getTX(d1, d2, d3);
                const prediction = currentResult === 'T' ? 'X' : 'T';
                return { prediction, confidence: 5 };
            }

            return null;
        }
    },
    {
        name: "Phân tích Xu hướng Xúc Xắc",
        needs: "full",
        detect: (fullHistory) => {
            if (fullHistory.length < 2) return null;
            const last = fullHistory[0];
            const prev = fullHistory[1];

            const delta1 = last.d1 - prev.d1;
            const delta2 = last.d2 - prev.d2;
            const delta3 = last.d3 - prev.d3;

            const maxChange = Math.max(Math.abs(delta1), Math.abs(delta2), Math.abs(delta3));
            if (maxChange >= 4) {
                const currentResult = getTX(last.d1, last.d2, last.d3);
                const prediction = currentResult === 'T' ? 'X' : 'T';
                return { prediction, confidence: 6 };
            }

            const totalMomentum = delta1 + delta2 + delta3;
            if (totalMomentum >= 5) {
                return { prediction: 'T', confidence: 4 };
            }
            if (totalMomentum <= -5) {
                return { prediction: 'X', confidence: 4 };
            }

            return null;
        }
    }
];

function analyzeSecondaryTransitions(history, target) {
    const transitions = { T: { T: 0, X: 0 }, X: { T: 0, X: 0 } };
    for (let i = 0; i < history.length - 1; i++) {
        const current = history[i];
        const next = history[i+1];
        if (transitions[next]) {
            transitions[next][current]++;
        }
    }
    const possibilities = transitions[target];
    const total = possibilities.T + possibilities.X;
    if (total < 4) return null;
    const diff = Math.abs(possibilities.T - possibilities.X);
    if (diff / total > 0.4) {
        return possibilities.T > possibilities.X ? 'T' : 'X';
    }
    return null;
}

function smarterPredict(fullHistory) {
    if (fullHistory.length < 3) {
        return { prediction: Math.random() < 0.5 ? 'T' : 'X', confidence: 50 };
    }

    const historyTX = fullHistory.map(r => getTX(r.d1, r.d2, r.d3));
    const activePredictions = [];

    for (const detector of detectors) {
        const historyForDetector = detector.needs === "full" ? fullHistory : historyTX;
        const result = detector.detect(historyForDetector);
        if (result) {
            activePredictions.push(result);
        }
    }

    if (activePredictions.length === 0) {
        const recentHistory = historyTX.slice(0, 20);
        const tCount = recentHistory.filter(r => r === 'T').length;
        const xCount = recentHistory.filter(r => r === 'X').length;
        if (Math.abs(tCount - xCount) / 20 >= 0.3) {
            return { prediction: tCount > xCount ? 'T' : 'X', confidence: 58 };
        }

        if (historyTX.length >= 20) {
            const secondaryPrediction = analyzeSecondaryTransitions(historyTX, historyTX[1]);
            if (secondaryPrediction) {
                return { prediction: secondaryPrediction, confidence: 55 };
            }
        }
        
        return { prediction: historyTX[0] === 'T' ? 'X' : 'T', confidence: 51 };
    }

    let scores = { T: 0, X: 0 };
    let counts = { T: 0, X: 0 };
    for (const pred of activePredictions) {
        scores[pred.prediction] += pred.confidence;
        counts[pred.prediction]++;
    }

    const finalPrediction = scores.T >= scores.X ? 'T' : 'X';
    let finalConfidence;

    const totalDetectorsFired = counts.T + counts.X;
    const agreementRatio = Math.max(counts.T, counts.X) / totalDetectorsFired;

    if (agreementRatio === 1) {
        finalConfidence = 95;
    } else if (agreementRatio > 0.6) {
        finalConfidence = 75 + Math.floor((agreementRatio - 0.6) * 50);
    } else {
        finalConfidence = 50 + Math.floor(Math.abs(scores.T - scores.X));
        finalConfidence = Math.min(65, finalConfidence);
    }
    
    return {
        prediction: finalPrediction,
        confidence: finalConfidence,
    };
}


// ==================================================================
// CÁC HÀM CỐT LÕI
// ==================================================================

function getTX(d1, d2, d3) {
  return d1 + d2 + d3 >= 11 ? "T" : "X";
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`📚 Loaded ${rikResults.length} history records`);
    }
  } catch (err) {
    console.error('Error loading history:', err);
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
  } catch (err) {
    console.error('Error saving history:', err);
  }
}

function decodeBinaryMessage(buffer) {
  try {
    const str = buffer.toString();
    if (str.startsWith("[")) return JSON.parse(str);
    let position = 0, result = [];
    while (position < buffer.length) {
      const type = buffer.readUInt8(position++);
      if (type === 1) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(buffer.toString('utf8', position, position + len));
        position += len;
      } else if (type === 2) {
        result.push(buffer.readInt32BE(position)); position += 4;
      } else if (type === 3 || type === 4) {
        const len = buffer.readUInt16BE(position); position += 2;
        result.push(JSON.parse(buffer.toString('utf8', position, position + len)));
        position += len;
      } else {
        console.warn("Unknown binary type:", type); break;
      }
    }
    return result.length === 1 ? result[0] : result;
  } catch (e) {
    console.error("Binary decode error:", e);
    return null;
  }
}

function sendRikCmd1005() {
  if (rikWS?.readyState === WebSocket.OPEN) {
    rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { cmd: 1005 }]));
  }
}

function connectRikWebSocket() {
  console.log("🔌 Connecting to SunWin WebSocket...");

  // SỬA LỖI: KẾT NỐI TRỰC TIẾP KHÔNG CÓ HEADERS
  rikWS = new WebSocket(`wss://websocket.azhkthg1.net/websocket?token=${TOKEN}`);

  rikWS.on("open", () => {
    const authPayload = [
        1, "MiniGame", "SC_apisunwin123", "binhlamtool90",
        {
          info: JSON.stringify({
            ipAddress: "2001:ee0:5708:7700:8af3:abd1:fe2a:c62c",
            wsToken: TOKEN,
            userId: "d93d3d84-f069-4b3f-8dac-b4716a812143",
            username: "SC_apisunwin123",
            timestamp: 1753443723662,
            refreshToken: "dd38d05401bb48b4ac3c2f6dc37f36d9.f22dccad89bb4e039814b7de64b05d63",
          }),
          signature: "4FD3165D59BD21DA76B4448EA62E81972BCD54BE0EDBC5291D2415274DA522089BF9318E829A67D07EC78783543D17E75671CBD6DF60B42B55643F13B66DEB7B0510DE995A8C7C8EDBA4990CE3294C4340D86BF78B02A0E90C6565D1A32EAA894F7384302602CB2703C20981244103E42817257592D42828D6EDB0BB781ADA1",
          pid: 5,
          subi: true
        }
      ];
    rikWS.send(JSON.stringify(authPayload));
    clearInterval(rikIntervalCmd);
    rikIntervalCmd = setInterval(sendRikCmd1005, 5000);
  });

  rikWS.on("message", (data) => {
    try {
      const json = typeof data === 'string' ? JSON.parse(data) : decodeBinaryMessage(data);
      if (!json) return;

      if (Array.isArray(json) && json[3]?.res?.d1) {
        const res = json[3].res;
        if (!rikCurrentSession || res.sid > rikCurrentSession) {
          rikCurrentSession = res.sid;
          rikResults.unshift({ sid: res.sid, d1: res.d1, d2: res.d2, d3: res.d3, timestamp: Date.now() });
          if (rikResults.length > 100) rikResults.pop();
          saveHistory();
          console.log(`📥 Phiên mới ${res.sid} → ${getTX(res.d1, res.d2, res.d3)}`);
        }
      } else if (Array.isArray(json) && json[1]?.htr) {
        rikResults = json[1].htr.map(i => ({
          sid: i.sid, d1: i.d1, d2: i.d2, d3: i.d3, timestamp: Date.now()
        })).sort((a, b) => b.sid - a.sid).slice(0, 100);
        saveHistory();
        console.log("📦 Đã tải lịch sử các phiên gần nhất.");
      }
    } catch (e) {
      console.error("❌ Parse error:", e.message);
    }
  });

  rikWS.on("close", () => {
    console.log("🔌 WebSocket disconnected. Reconnecting...");
    setTimeout(connectRikWebSocket, 5000);
  });

  rikWS.on("error", (err) => {
    console.error("🔌 WebSocket error:", err.message);
    rikWS.close();
  });
}

loadHistory();
connectRikWebSocket();
fastify.register(cors);

// ==================================================================
// API ENDPOINT
// ==================================================================

fastify.get("/api/taixiu/sunwin", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu." };

  const current = valid[0];
  const sum = current.d1 + current.d2 + current.d3;
  const ket_qua = sum >= 11 ? "Tài" : "Xỉu";

  const prediction = smarterPredict(valid);

  const patternString = valid
    .slice(0, 13)
    .map(session => getTX(session.d1, session.d2, session.d3))
    .reverse()
    .join('');

  return {
    id: "tieptool",
    phien: current.sid,
    xuc_xac_1: current.d1,
    xuc_xac_2: current.d2,
    xuc_xac_3: current.d3,
    tong: sum,
    ket_qua,
    du_doan: prediction.prediction === "T" ? "Tài" : "Xỉu",
    ty_le_thanh_cong: `${prediction.confidence}%`,
    pattern: patternString,
  };
});

fastify.get("/api/taixiu/history", async () => {
  const valid = rikResults.filter(r => r.d1 && r.d2 && r.d3);
  if (!valid.length) return { message: "Không có dữ liệu lịch sử." };
  return valid.map(i => ({
    session: i.sid,
    dice: [i.d1, i.d2, i.d3],
    total: i.d1 + i.d2 + i.d3,
    result: getTX(i.d1, i.d2, i.d3) === "T" ? "Tài" : "Xỉu"
  })).map(JSON.stringify).join("\n");
});

const start = async () => {
  try {
    const address = await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`🚀 API chạy tại ${address}`);
  } catch (err) {
    console.error("❌ Server error:", err);
    process.exit(1);
  }
};

start();
