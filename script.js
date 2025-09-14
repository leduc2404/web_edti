// Lấy element
const videoFileInput = document.getElementById('video-file');
const startBtn = document.getElementById('start-btn');
const statusDiv = document.getElementById('status');
const logOutput = document.getElementById('log-output');
const resultSection = document.getElementById('result-section');
const downloadLink = document.getElementById('download-link');

// Cấu hình
let config = {};

// FFmpeg global từ CDN
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
  log: true,
  corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
});

// Log tiện dụng
const log = (message) => {
  logOutput.textContent += message + '\n';
  logOutput.scrollTop = logOutput.scrollHeight;
};
ffmpeg.setLogger(({ message }) => log(`[FFMPEG] ${message}`));
const setStatus = (message) => (statusDiv.textContent = `Trạng thái: ${message}`);

// ====================== MODULES =======================

// 1) Tạo caption bằng Gemini
async function generateCaptionFromVideo(videoFile, apiKey) {
  log("\n--- BƯỚC 1: Đang tạo caption bằng Google Gemini ---");
  if (!apiKey) throw new Error("Không tìm thấy Google Gemini API Key trong file config.json.");

  // ✅ Sửa: dùng global đúng của CDN
  const genAI = new (window.GoogleGenerativeAI || (window.genai && window.genai.GoogleGenerativeAI))(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const fileToGenerativePart = async (file) => {
    const base64EncodedData = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(file);
    });
    return { inlineData: { data: base64EncodedData, mimeType: file.type } };
  };

  const videoPart = await fileToGenerativePart(videoFile);
  const prompt =
    "Hãy viết cho tôi một câu hook bán hàng ngắn gọn, hấp dẫn, bằng tiếng Việt, độ dài trong khoảng 25–35 chữ, không được quá ít. Nội dung nhấn mạnh sự cần thiết của sản phẩm, mang phong cách trẻ trung, dễ gây chú ý trên mạng xã hội, bắt trend. Chỉ xuất ra duy nhất văn bản thô, không được sử dụng từ tiếng Anh như big size,..., không thêm tiêu đề, nhắc nhở, icon hay bất kỳ yếu tố nào khác, không được sai chính tả";

  log("Đang gửi video và prompt đến Gemini...");
  const result = await model.generateContent([prompt, videoPart]);
  const response = await result.response;
  const text = response.text().trim();
  if (!text) throw new Error("Gemini không trả về caption. Vui lòng thử lại.");

  log(`Tạo caption thành công: '${text}'`);
  return text;
}

// 2) Text → Audio (FPT.AI)
async function generateAudioFromText(text, apiKey) {
  log("\n--- BƯỚC 2: Đang tạo audio bằng FPT.AI TTS ---");
  if (!apiKey) throw new Error("Không tìm thấy FPT.AI API Key trong file config.json.");

  const ttsSettings = { voice: "banmai", speed: 1.2, max_retries: 10, retry_delay: 2000 };
  const headers = { 'api-key': apiKey, 'voice': ttsSettings.voice, 'speed': String(ttsSettings.speed) };

  log("Gửi yêu cầu tạo audio đến FPT.AI...");
  const initialResponse = await fetch("https://api.fpt.ai/hmi/tts/v5", {
    method: 'POST', headers, body: text
  });
  if (!initialResponse.ok) throw new Error(`FPT.AI API error: ${initialResponse.statusText}`);

  const data = await initialResponse.json();
  const asyncLink = data.async;
  if (!asyncLink) throw new Error(`FPT.AI không trả về link tải. Phản hồi: ${JSON.stringify(data)}`);

  log("Yêu cầu thành công! Đang chờ và tải audio...");
  for (let i = 0; i < ttsSettings.max_retries; i++) {
    await new Promise(r => setTimeout(r, ttsSettings.retry_delay));
    log(`Đang thử tải audio lần ${i + 1}/${ttsSettings.max_retries}...`);
    const audioResponse = await fetch(asyncLink);
    if (audioResponse.ok) {
      log("Tải audio thành công!");
      const audioBlob = await audioResponse.blob();

      // Chuyển mp3 → wav để ghép dễ hơn
      ffmpeg.FS('writeFile', 'temp_tts.mp3', await fetchFile(audioBlob));
      await ffmpeg.run('-i', 'temp_tts.mp3', 'temp_tts.wav');
      const wavData = ffmpeg.FS('readFile', 'temp_tts.wav');
      return new Blob([wavData.buffer], { type: 'audio/wav' });
    }
  }
  throw new Error("Hết thời gian chờ, không thể tải file audio từ FPT.AI.");
}

// 3) Ghép video (không còn run 'giả ffprobe' gây lỗi)
async function combineVideoWithFFmpeg(videoFile, audioBlob, captionText, overlayFile, fontFile, logoFile) {
  log("\n--- BƯỚC 3: Đang ghép các thành phần bằng FFmpeg ---");

  // Nạp file vào FS
  log("Nạp file vào bộ nhớ của FFmpeg...");
  ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(videoFile));
  ffmpeg.FS('writeFile', 'tts.wav', await fetchFile(audioBlob));
  ffmpeg.FS('writeFile', 'overlay.png', await fetchFile(overlayFile));
  ffmpeg.FS('writeFile', 'logo.png', await fetchFile(logoFile));
  ffmpeg.FS('writeFile', 'font.otf', await fetchFile(fontFile));

  // Chuẩn bị text
  const WRAP_AFTER_CHARS = 30;
  const LINE_SPACING = 11;
  const wrapText = (text, maxChars) => {
    const words = text.split(' ');
    let lines = [], line = "";
    for (const w of words) {
      if (!line) line = w;
      else if (line.length + 1 + w.length <= maxChars) line += " " + w;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.join('\n');
  };
  const textWrapped = wrapText(captionText.toUpperCase(), WRAP_AFTER_CHARS);
  const textEscaped = textWrapped.replace(/'/g, `''`).replace(/:/g, `\\:`);

  // Filter ổn định, không cần biết width/height, không cần độ dài audio
  const filter_complex = `
    [1][0]scale2ref=w=iw:h=ih[ovl][base];
    [ovl]format=rgba[ovl];
    [base][ovl]overlay=0:0[bg];
    [3]scale=200:-1[logo];
    [bg]drawtext=fontfile=/font.otf:text='${textEscaped}':fontsize=33:fontcolor=white:
        borderw=2:bordercolor=black@0.6:line_spacing=${LINE_SPACING}:
        x=(w-text_w)/2:y=(h-text_h)*0.82:text_shaping=1[bgtext];
    [bgtext][logo]overlay=x=W-w-30:y=H*0.68-h[final_v]
  `.replace(/\s+/g, ' ');

  log("Bắt đầu chạy lệnh FFmpeg để ghép video...");
  await ffmpeg.run(
    '-i', 'input.mp4',
    '-i', 'overlay.png',
    '-i', 'tts.wav',
    '-i', 'logo.png',
    '-filter_complex', filter_complex,
    '-map', '[final_v]',
    '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '192k',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    'output.mp4'
  );

  log("Ghép video thành công!");
  const data = ffmpeg.FS('readFile', 'output.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ====================== MAIN FLOW =======================
async function startProcessing() {
  startBtn.disabled = true;
  logOutput.textContent = '';
  resultSection.classList.add('hidden');
  setStatus('Đang khởi tạo...');

  try {
    const videoFile = videoFileInput.files[0];
    if (!videoFile) throw new Error("Vui lòng chọn một video để xử lý.");

    if (!ffmpeg.isLoaded()) {
      log("Đang tải FFmpeg core... (chỉ lần đầu)");
      await ffmpeg.load();
    }

    setStatus("Đang tải các file tài sản (assets)...");
    log("Đang tải các file tài sản (assets)...");
    const [overlayFile, logoFile, fontFile] = await Promise.all([
      fetch(config.asset_paths.overlay).then(res => res.blob()),
      fetch(config.asset_paths.logo).then(res => res.blob()),
      fetch(config.asset_paths.font).then(res => res.blob()),
    ]);
    log("Tải tài sản thành công!");

    setStatus('Đang tạo caption...');
    const caption = await generateCaptionFromVideo(videoFile, config.api_keys.google_gemini);

    setStatus('Đang tạo audio...');
    const audioBlob = await generateAudioFromText(caption, config.api_keys.fpt_ai);

    setStatus('Đang ghép video cuối cùng...');
    const resultBlob = await combineVideoWithFFmpeg(videoFile, audioBlob, caption, overlayFile, fontFile, logoFile);

    log("\n🎉🎉🎉 QUY TRÌNH HOÀN TẤT! 🎉🎉🎉");
    setStatus('Hoàn thành!');
    const url = URL.createObjectURL(resultBlob);
    downloadLink.href = url;
    downloadLink.download = `final_video_${Date.now()}.mp4`;
    resultSection.classList.remove('hidden');
  } catch (error) {
    log(`\n--- LỖI NGHIÊM TRỌNG ---`);
    log(error.message);
    console.error(error);
    setStatus(`Đã xảy ra lỗi. Xem console (F12) để biết chi tiết.`);
  } finally {
    startBtn.disabled = false;
  }
}

// ====================== INIT =======================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('config.json');
    if (!response.ok) throw new Error(`Không thể tải config.json (status: ${response.status})`);
    config = await response.json();

    if (!config.api_keys || !config.asset_paths) {
      throw new Error("File config.json có cấu trúc không hợp lệ.");
    }

    log("Tải file cấu hình thành công. Sẵn sàng để xử lý.");
    setStatus("Sẵn sàng");
    startBtn.textContent = "▶ Bắt đầu xử lý";
    startBtn.disabled = false;
  } catch (error) {
    log(`LỖI KHỞI TẠO: ${error.message}`);
    setStatus("Lỗi tải cấu hình!");
    startBtn.textContent = "Lỗi cấu hình";
  }
});

startBtn.addEventListener('click', startProcessing);
