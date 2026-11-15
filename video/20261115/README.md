# 第二期更新视频工程

成片为 1920 × 1080、30 fps，18 个场景，约 9 分 17 秒。配音沿用阿里云 `qwen-audio-3.1-tts-flash` 的 `longanlingxi_v3.1`（龙安灵希），自然语速。

`scenes.json` 保存旁白和画面信息。`speech.py` 从当前用户的统一 API 凭据索引读取 aliyun 服务，在请求进程内使用密钥。阿里云端点来自该索引的 speech 配置。工程不包含密钥和音频原件。

`make_video.py` 用 Pillow 生成图解画面，使用语音 API 的逐词时间戳生成 213 条字幕，并由 FFmpeg 合成 H.264/AAC 成片。18 段字幕与原旁白时间戳均完整匹配。`verify_audio.py` 可选用本机离线 Whisper 模型检查段落结尾，模型路径由参数指定。离线转写可能出现同音字、繁简差异和尾部识别幻觉，字幕采用原旁白及语音 API 时间戳。

生成配音后运行 `python make_video.py`，`--preview` 只生成画面与字幕。需要 Python 的 Pillow、numpy，及 PATH 中的 ffmpeg、ffprobe。Windows 字体使用微软雅黑，其他系统可调整字体路径。

画面采用流程示意与实际测量图表。完整讲解覆盖自定义指令主动转发、固定程序持久化、微信来信处理、90 MB 二进制分段与续传、100,002,422 字节 PDF 实测、延迟拆解及部署。
