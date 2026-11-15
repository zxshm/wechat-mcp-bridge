"""用本机离线模型复核各段配音结尾及静音区间，不上传音频。"""
import argparse
import difflib
import json
import re
import sys
import wave
from pathlib import Path

import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--model', required=True)
parser.add_argument('--deps', required=True)
args = parser.parse_args()
sys.path.insert(0, args.deps)
from faster_whisper import WhisperModel

root = Path(__file__).resolve().parent
scenes = json.loads((root/'scenes.json').read_text(encoding='utf-8'))
model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=6, local_files_only=True)
results = []
normalize = lambda value: re.sub(r'[^\w]', '', value).lower()
for index, scene in enumerate(scenes, 1):
    path = root/'audio'/f'{index:02}.wav'
    with wave.open(str(path), 'rb') as source:
        rate = source.getframerate()
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').astype(np.float32)/32768
    # 通过线性重采样提供识别器所需的 16 kHz 单声道输入。
    sampled = np.interp(np.arange(0, len(samples), rate/16000), np.arange(len(samples)), samples).astype(np.float32)
    segments, _ = model.transcribe(sampled, language='zh', beam_size=5, condition_on_previous_text=False, vad_filter=True)
    segments = list(segments)
    transcript = ''.join(segment.text for segment in segments)
    similarity = difflib.SequenceMatcher(None, normalize(scene['speech']), normalize(transcript), autojunk=False).ratio()
    metadata = json.loads(path.with_suffix('.json').read_text(encoding='utf-8'))
    words = [word for sentence in metadata['sentences'].values() for word in sentence['words']]
    last_end = max(word['end_time'] for word in words)/1000
    tail = samples[min(len(samples), int((last_end+.15)*rate)):]
    tail_rms = float(np.sqrt(np.mean(tail**2))) if len(tail) else 0
    results.append({'scene':index,'transcript':transcript,'similarity':similarity,'lastTimestamp':last_end,
                    'duration':len(samples)/rate,'tailRms':tail_rms,'asrLastEnd':segments[-1].end if segments else None})
    (root/'audio/qa.json').write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f'{index:02} 相似度 {similarity:.3f} 结尾能量 {tail_rms:.5f}', flush=True)
