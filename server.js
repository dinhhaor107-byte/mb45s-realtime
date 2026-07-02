const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cổng chạy ứng dụng (Railway tự cấp phát hoặc mặc định 3000)
const PORT = process.env.PORT || 3000;
const SESSION_TOKEN = process.env.SESSION_TOKEN || 'CjU0MTv+xXixlZuI2ZFk6EhOWjg1fR78LR46e7ZpO0YsbQS8Tyd1FmS8t1Y=';

// Biến lưu trữ dữ liệu thời gian thực trong bộ nhớ
let lotteryHistory = [];
let savedL2Data = {};
let predictionData = {
  de70: [],
  de10: [],
  lastUpdate: 'Chưa cập nhật',
  latestIssue: 'Đang tải...',
  latestOpenCode: ''
};

// Hàm trích xuất 2 số cuối giải đặc biệt
function extractDeDigits(row) {
  if (!row) return null;
  let str = row.openNum || row.openCode || row.result || row.code;
  if (str) {
    str = String(str).replace(/,/g, '').trim(); 
    if (str.length >= 2) {
      const deStr = str.slice(-2);
      return { chuc: parseInt(deStr[0]), donvi: parseInt(deStr[1]) };
    }
  }
  if (row.detail) {
    try {
      const detailArr = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
      const gdb = detailArr[0].split(",")[0];
      const deStr = gdb.slice(-2);
      if (deStr.length === 2) {
        return { chuc: parseInt(deStr[0]), donvi: parseInt(deStr[1]) };
      }
    } catch(e) {}
  }
  return null;
}

// Thuật toán chấm điểm và tạo dàn 70 số & 10 số
function calculatePredictions() {
  if (lotteryHistory.length === 0) return;

  const deList = [];
  lotteryHistory.forEach(row => {
    const digits = extractDeDigits(row);
    if (digits) deList.push(digits);
  });

  if (deList.length === 0) return;

  // Tạo danh sách 100 số từ 00 đến 99
  const allNumbers = [];
  for (let i = 0; i < 100; i++) {
    allNumbers.push(i.toString().padStart(2, '0'));
  }

  // Chấm điểm từng số
  const scoredNumbers = allNumbers.map(num => {
    let score = 100;

    // 1. Điểm tần suất (Chỉ xét 50 kỳ gần nhất)
    const frequency = deList.slice(0, 50).filter(item => `${item.chuc}${item.donvi}` === num).length;
    score += frequency * 12;

    // 2. Điểm phạt lặp ngắn hạn (Đề vừa về)
    const lastSeenIdx = deList.findIndex(item => `${item.chuc}${item.donvi}` === num);
    if (lastSeenIdx !== -1) {
      if (lastSeenIdx === 0) score -= 90; // kỳ vừa nổ
      else if (lastSeenIdx === 1) score -= 50; // cách 1 kỳ
      else if (lastSeenIdx === 2) score -= 30; // cách 2 kỳ
    }

    // 3. Xử lý Lô Gan (Omit)
    const ganCount = savedL2Data[num] !== undefined ? savedL2Data[num] : (savedL2Data[parseInt(num)] || 0);
    if (ganCount > 20) {
      score -= 75; // Phạt số gan cực đại (khan chết)
    } else if (ganCount >= 10 && ganCount <= 18) {
      score += 15; // Điểm rơi lý tưởng, dễ nổ
    }

    return { number: num, score };
  });

  // Tạo dàn 70 số tốt nhất
  const best70 = [...scoredNumbers].sort((a, b) => b.score - a.score).slice(0, 70).map(item => item.number);
  best70.sort((a, b) => parseInt(a) - parseInt(b)); // Sắp xếp tăng dần để dễ cược

  // Tạo dàn 10 số tốt nhất
  const best10 = [...scoredNumbers].sort((a, b) => b.score - a.score).slice(0, 10).map(item => item.number);
  best10.sort((a, b) => parseInt(a) - parseInt(b));

  predictionData = {
    de70: best70,
    de10: best10,
    lastUpdate: new Date().toLocaleTimeString('vi-VN'),
    latestIssue: lotteryHistory[0].issue || lotteryHistory[0].turnNum || lotteryHistory[0].period || 'Chưa rõ',
    latestOpenCode: lotteryHistory[0].openNum || lotteryHistory[0].openCode || lotteryHistory[0].result || 'Đang quay...'
  };
  
  console.log(`[ALGORITHM] Cập nhật dự đoán thành công. Tổng lịch sử tích lũy: ${lotteryHistory.length} kỳ. Kỳ mới nhất: ${predictionData.latestIssue}`);
}

// Gửi yêu cầu API đến nhà cái
async function fetchFromGame(endpoint, body = {}) {
  const url = `https://7c8z.123vtv9.me${endpoint}`;
  const headers = {
    "x-session-token": SESSION_TOKEN,
    "Content-Type": "application/json;charset=UTF-8",
    "locale": "vi",
    "platform": "web",
    "Origin": "https://7c8z.123vtv9.me",
    "Referer": "https://7c8z.123vtv9.me/home/game.html?gameId=276",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });
    
    if (!res.ok) {
      console.error(`[API ERROR] ${endpoint} trả về mã lỗi HTTP: ${res.status}`);
      return null;
    }
    
    return await res.json();
  } catch (e) {
    console.error(`[FETCH EXCEPTION] Không thể kết nối tới ${endpoint}:`, e.message);
    return null;
  }
}

// Điểm cuối nhận đồng bộ dữ liệu đẩy từ Trình duyệt (dành cho trường hợp IP Cloud bị chặn)
app.post('/api/push', (req, res) => {
  try {
    const { history, omitData } = req.body;
    let updated = false;

    if (history && Array.isArray(history) && history.length > 0) {
      // Hợp nhất và loại bỏ trùng lặp kỳ quay dựa trên turnNum/issue
      const existingMap = new Map();
      
      // Đưa lịch sử hiện tại trên server vào Map
      lotteryHistory.forEach(item => {
        const key = item.issue || item.turnNum || item.period;
        if (key) existingMap.set(String(key), item);
      });

      // Trộn thêm lịch sử mới đẩy lên từ trình duyệt vào Map
      history.forEach(item => {
        const key = item.issue || item.turnNum || item.period;
        if (key) existingMap.set(String(key), item);
      });

      // Chuyển Map ngược lại thành mảng và sắp xếp giảm dần theo mã kỳ quay
      const mergedList = Array.from(existingMap.values());
      mergedList.sort((a, b) => {
        const keyA = String(a.issue || a.turnNum || a.period);
        const keyB = String(b.issue || b.turnNum || b.period);
        return keyB.localeCompare(keyA, undefined, { numeric: true, sensitivity: 'base' });
      });

      // Lưu trữ tối đa 2000 kỳ quay để tối ưu hóa bộ nhớ RAM
      lotteryHistory = mergedList.slice(0, 2000);
      updated = true;
      console.log(`[PUSH SYNC] Đã hợp nhất lịch sử. Tổng số kỳ lưu trữ trên Cloud: ${lotteryHistory.length}`);
    }

    if (omitData && typeof omitData === 'object' && !Array.isArray(omitData) && Object.keys(omitData).length > 0) {
      savedL2Data = omitData;
      updated = true;
      console.log(`[PUSH SYNC] Nhận được dữ liệu lô gan từ trình duyệt.`);
    }

    if (updated) {
      calculatePredictions();
      res.json({ success: true, msg: "Đồng bộ thành công!", totalStored: lotteryHistory.length });
    } else {
      res.json({ success: false, msg: "Không có dữ liệu hợp lệ" });
    }
  } catch (err) {
    console.error("[PUSH ERROR] Lỗi khi xử lý dữ liệu đẩy lên:", err.message);
    res.status(500).json({ success: false, msg: "Lỗi hệ thống khi đồng bộ" });
  }
});


// Cập nhật Lô Gan (Omit) mỗi 5 phút
async function updateOmitData() {
  if (!SESSION_TOKEN) {
    console.warn("[WARNING] Chưa cấu hình SESSION_TOKEN. Bỏ qua cập nhật Lô Gan.");
    return;
  }
  
  console.log("[CRON] Đang tải dữ liệu lô gan từ server...");
  const json = await fetchFromGame('/api/front/lottery/getAnalysisResult', { gameId: 276 });
  if (json && json.success && json.t && json.t.l2) {
    savedL2Data = json.t.l2;
    console.log("[CRON] Tải thành công dữ liệu lô gan mới.");
  } else {
    console.warn("[CRON] Tải dữ liệu lô gan thất bại:", json ? json.msg : 'Không có phản hồi');
  }
}

// Đồng bộ lịch sử (Chạy mỗi 15 giây)
async function updateHistoryData() {
  if (!SESSION_TOKEN) {
    console.warn("[WARNING] Chưa cấu hình SESSION_TOKEN. Bỏ qua tải lịch sử cược.");
    return;
  }

  const json = await fetchFromGame('/api/front/lottery/getLotteryResultByPage', {
    gameId: 276,
    page: 1,
    pageSize: 50
  });

  let rows = [];
  if (json) {
    if (json.success && json.t && json.t.rows) rows = json.t.rows;
    else if (json.rows) rows = json.rows;
    else if (json.t && json.t.list) rows = json.t.list;
  }

  if (rows && rows.length > 0) {
    const latestLocalIssue = lotteryHistory[0] ? (lotteryHistory[0].issue || lotteryHistory[0].turnNum || lotteryHistory[0].period) : null;
    const incomingLatestIssue = rows[0].issue || rows[0].turnNum || rows[0].period;

    if (incomingLatestIssue !== latestLocalIssue) {
      console.log(`[NEW DRAW] Phát hiện kỳ quay mới: ${incomingLatestIssue}`);
      lotteryHistory = rows;
      calculatePredictions();
    }
  } else {
    console.warn("[WARNING] Lịch sử cược rỗng hoặc bị từ chối truy cập. Vui lòng kiểm tra lại SESSION_TOKEN.");
  }
}

// Điểm cuối API trả dữ liệu cho giao diện web
app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    data: predictionData
  });
});

// Điểm cuối xem chi tiết toàn bộ lịch sử kỳ quay tích lũy
app.get('/api/history', (req, res) => {
  res.json({
    success: true,
    total: lotteryHistory.length,
    history: lotteryHistory
  });
});

// Trả về trang chủ Dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Khởi chạy máy chủ
app.listen(PORT, async () => {
  console.log(`==================================================`);
  console.log(`🚀 Máy chủ thống kê cược đang chạy trên cổng: ${PORT}`);
  console.log(`🔑 Cấu hình Token bảo mật: ${SESSION_TOKEN ? 'ĐÃ CẤU HÌNH' : 'CHƯA CẤU HÌNH (SESSION_TOKEN)'}`);
  console.log(`==================================================`);

  if (SESSION_TOKEN) {
    // Tải dữ liệu ban đầu
    await updateOmitData();
    await updateHistoryData();
    
    // Thiết lập tiến trình tự động lặp
    setInterval(updateHistoryData, 15000); // Tải lịch sử mỗi 15 giây
    setInterval(updateOmitData, 300000);   // Tải lại lô gan mỗi 5 phút
  }
});
