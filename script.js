import { GoogleGenerativeAI } from "https://unpkg.com/@google/generative-ai@0.1.3/dist/index.esm.js";
// Sử dụng thư viện đã nạp từ CDN
const { createFFmpeg, fetchFile } = FFmpeg;
// const { GoogleGenerativeAI } = genai; // <<<<<<< XÓA HOẶC COMMENT DÒNG NÀY LẠI

// Lấy các element từ DOM
const videoFileInput = document.getElementById('video-file');
const startBtn = document.getElementById('start-btn');
const statusDiv = document.getElementById('status');
const logOutput = document.getElementById('log-output');
const resultSection = document.getElementById('result-section');
const downloadLink = document.getElementById('download-link');

// Biến toàn cục để lưu cấu hình
let config = {};

// Khởi tạo FFmpeg
const ffmpeg = createFFmpeg({
    log: true,
    corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
});

// Hàm ghi log ra giao diện
const log = (message) => {
    logOutput.textContent += message + '\n';
    logOutput.scrollTop = logOutput.scrollHeight;
};

ffmpeg.setLogger(({ type, message }) => {
    log(`[FFMPEG] ${message}`);
});

// Hàm cập nhật trạng thái
const setStatus = (message) => {
    statusDiv.textContent = `Trạng thái: ${message}`;
};

// ==============================================================================
// CÁC MODULE XỬ LÝ
// ==============================================================================

// MODULE 1: TẠO CAPTION TỪ VIDEO (Google Gemini)
async function generateCaptionFromVideo(videoFile, apiKey) {
    log("\n--- BƯỚC 1: Đang tạo caption bằng Google Gemini ---");
    if (!apiKey) throw new Error("Không tìm thấy Google Gemini API Key trong file config.json.");
    
    // SỬA LỖI Ở ĐÂY: Sử dụng genai.GoogleGenerativeAI thay vì GoogleGenerativeAI
    const genAI = new GoogleGenerativeAI(apiKey); // <<<<<<< THAY ĐỔI Ở ĐÂY
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
    const prompt = "Hãy viết cho tôi một câu hook bán hàng ngắn gọn, hấp dẫn, bằng tiếng Việt, độ dài trong khoảng 25–35 chữ, không được quá ít. Nội dung nhấn mạnh sự cần thiết của sản phẩm, mang phong cách trẻ trung, dễ gây chú ý trên mạng xã hội, bắt trend. Chỉ xuất ra duy nhất văn bản thô, không được sử dụng từ tiếng Anh như big size,..., không thêm tiêu đề, nhắc nhở, icon hay bất kỳ yếu tố nào khác, không được sai chính tả";

    log("Đang gửi video và prompt đến Gemini...");
    const result = await model.generateContent([prompt, videoPart]);
    const response = await result.response;
    const text = response.text().trim();

    if (!text) throw new Error("Gemini không trả về caption. Vui lòng thử lại.");
    
    log(`Tạo caption thành công: '${text}'`);
    return text;
}

// MODULE 2: TẠO ÂM THANH TỪ TEXT (FPT.AI TTS)
async function generateAudioFromText(text, apiKey) {
    log("\n--- BƯỚC 2: Đang tạo audio bằng FPT.AI TTS ---");
    if (!apiKey) throw new Error("Không tìm thấy FPT.AI API Key trong file config.json.");

    const ttsSettings = { voice: "banmai", speed: 1.2, max_retries: 10, retry_delay: 2000 };
    const headers = { 'api-key': apiKey, 'voice': ttsSettings.voice, 'speed': String(ttsSettings.speed) };
    
    log("Gửi yêu cầu tạo audio đến FPT.AI...");
    const initialResponse = await fetch("https://api.fpt.ai/hmi/tts/v5", { method: 'POST', headers: headers, body: text });
    if (!initialResponse.ok) throw new Error(`FPT.AI API error: ${initialResponse.statusText}`);
    
    const data = await initialResponse.json();
    const asyncLink = data.async;
    if (!asyncLink) throw new Error(`FPT.AI không trả về link tải. Phản hồi: ${JSON.stringify(data)}`);

    log("Yêu cầu thành công! Đang chờ và tải audio...");
    for (let i = 0; i < ttsSettings.max_retries; i++) {
        await new Promise(resolve => setTimeout(resolve, ttsSettings.retry_delay));
        log(`Đang thử tải audio lần ${i + 1}/${ttsSettings.max_retries}...`);
        const audioResponse = await fetch(asyncLink);
        if (audioResponse.ok) {
            log("Tải audio thành công!");
            const audioBlob = await audioResponse.blob();
            ffmpeg.FS('writeFile', 'temp_tts.mp3', await fetchFile(audioBlob));
            await ffmpeg.run('-i', 'temp_tts.mp3', 'temp_tts.wav');
            const wavData = ffmpeg.FS('readFile', 'temp_tts.wav');
            return new Blob([wavData.buffer], { type: 'audio/wav' });
        }
    }
    throw new Error("Hết thời gian chờ, không thể tải file audio từ FPT.AI.");
}

// MODULE 3: GHÉP VIDEO (FFmpeg.wasm)
async function combineVideoWithFFmpeg(videoFile, audioBlob, captionText, overlayFile, fontFile, logoFile) {
    log("\n--- BƯỚC 3: Đang ghép các thành phần bằng FFmpeg ---");
    log("Nạp file vào bộ nhớ của FFmpeg...");
    ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(videoFile));
    ffmpeg.FS('writeFile', 'tts.wav', await fetchFile(audioBlob));
    ffmpeg.FS('writeFile', 'overlay.png', await fetchFile(overlayFile));
    ffmpeg.FS('writeFile', 'logo.png', await fetchFile(logoFile));
    ffmpeg.FS('writeFile', 'font.otf', await fetchFile(fontFile));
    
    log("Lấy thông tin media...");
    // Chạy một lệnh đơn giản để ffprobe phân tích các file đầu vào
    await ffmpeg.run('-i', 'input.mp4', '-i', 'tts.wav');
    const infoLog = logOutput.textContent;
    
    // Phân tích log để lấy thông tin. Cách này hơi thủ công nhưng hiệu quả.
    const durationMatches = infoLog.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/g);
    const audioDurationStr = durationMatches[1]; // Lấy duration của file thứ 2 (audio)
    const parts = audioDurationStr.match(/(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    const tts_duration = parseFloat(parts[1]) * 3600 + parseFloat(parts[2]) * 60 + parseFloat(parts[3]);
    
    const videoStreamMatch = infoLog.match(/Stream #0:0.*, (\d+)x(\d+)/);
    const video_width = parseInt(videoStreamMatch[1]);
    const video_height = parseInt(videoStreamMatch[2]);

    log(`Thông tin media: Rộng=${video_width}, Cao=${video_height}, Thời lượng audio=${tts_duration.toFixed(2)}s`);

    const FADE_DURATION = 1.0, FONT_SIZE = 33, TEXT_V_POS_RATIO = 0.82, WRAP_AFTER_CHARS = 30, LINE_SPACING = 11, LOGO_SCALE_RATIO = 0.2, LOGO_V_POS_RATIO = 0.68, LOGO_H_MARGIN_RATIO = 0.73;

    const wrapText = (text, maxChars) => {
        const words = text.split(' ');
        let lines = [];
        let currentLine = "";
        for (const word of words) {
            if (!currentLine) {
                currentLine = word;
            } else if (currentLine.length + 1 + word.length <= maxChars) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines.join('\n');
    };
    
    const text_content_wrapped = wrapText(captionText.toUpperCase(), WRAP_AFTER_CHARS);
    const text_content_escaped = text_content_wrapped.replace(/'/g, `''`).replace(/:/g, `\\:`);

    const fade_start_time = tts_duration - FADE_DURATION;
    const text_y_pos = `(h-text_h)*${TEXT_V_POS_RATIO}`;
    const logo_new_width = Math.round(video_width * LOGO_SCALE_RATIO);
    const logo_margin_right_px = Math.round(video_width * LOGO_H_MARGIN_RATIO);

    const filter_complex = `[1:v]scale=${video_width}:${video_height}[bg];[bg]drawtext=fontfile=/font.otf:text='${text_content_escaped}':fontsize=${FONT_SIZE}:fontcolor=white:x=(w-text_w)/2:y=${text_y_pos}:line_spacing=${LINE_SPACING}[bg_with_text];[3:v]scale=${logo_new_width}:-1[logo_scaled];[bg_with_text][logo_scaled]overlay=x=main_w-overlay_w-${logo_margin_right_px}:y=main_h*${LOGO_V_POS_RATIO}-overlay_h[composite_overlay];[composite_overlay]fade=t=out:st=${fade_start_time}:d=${FADE_DURATION}:alpha=1[faded_composite];[0:v][faded_composite]overlay=0:0:enable='between(t,0,${tts_duration})'[final_v]`.replace(/\s+/g, ' ');

    log("Bắt đầu chạy lệnh FFmpeg để ghép video...");
    await ffmpeg.run('-i', 'input.mp4', '-i', 'overlay.png', '-i', 'tts.wav', '-i', 'logo.png', '-filter_complex', filter_complex, '-map', '[final_v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', 'output.mp4');

    log("Ghép video thành công!");
    const data = ffmpeg.FS('readFile', 'output.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
}

// ==============================================================================
// HÀM MAIN: QUẢN LÝ QUY TRÌNH
// ==============================================================================
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
        console.error(error); // In lỗi chi tiết ra console để debug
        setStatus(`Đã xảy ra lỗi. Xem console (F12) để biết chi tiết.`);
    } finally {
        startBtn.disabled = false;
    }
}

// ==============================================================================
// KHỞI TẠO TRANG
// ==============================================================================
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