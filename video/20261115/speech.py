import argparse
import base64
import hashlib
import importlib.util
import json
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def credentials():
    path = Path.home() / '.config/codex-credentials/client.py'
    spec = importlib.util.spec_from_file_location('local_api_credentials', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_credentials('aliyun')

def synthesize(scene, index, key, endpoint):
    folder = ROOT / 'audio'
    folder.mkdir(exist_ok=True)
    path = folder / f'{index:02}.wav'
    metadata = path.with_suffix('.json')
    text_hash = hashlib.sha256(scene['speech'].encode()).hexdigest()
    if path.exists() and metadata.exists() and json.loads(metadata.read_text(encoding='utf-8'))['textSha256'] == text_hash:
        print(f'复用第{index}段', flush=True)
        return
    body = {'model':'qwen-audio-3.1-tts-flash', 'input':{
        'text':scene['speech'], 'voice':'longanlingxi_v3.1', 'format':'pcm',
        'sample_rate':24000, 'rate':1, 'pitch':1, 'volume':50,
        'word_timestamp_enabled':True, 'language_hints':['zh']}}
    request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False).encode(), headers={
        'Authorization':'Bearer '+key, 'Content-Type':'application/json', 'X-DashScope-SSE':'enable'})
    audio = bytearray()
    sentences = {}
    usage = None
    stopped = False
    event_types = set()
    def consume(lines):
        nonlocal usage, stopped
        if not lines:
            return
        event = json.loads('\n'.join(lines))
        if event.get('code'):
            raise RuntimeError('语音接口返回错误 '+str(event.get('code')))
        output = event.get('output', {})
        event_types.add(output.get('type', 'final'))
        data = output.get('audio', {}).get('data')
        if data:
            audio.extend(base64.b64decode(data))
        sentence = output.get('sentence')
        if sentence:
            sentences[str(sentence['index'])] = sentence
        if event.get('usage'):
            usage = event['usage']
        if output.get('finish_reason') == 'stop':
            stopped = True
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            if 'text/event-stream' not in response.headers.get('Content-Type', ''):
                raise RuntimeError('接口未返回预期的流式语音结果')
            lines = []
            for raw in response:
                line = raw.decode('utf-8').rstrip('\r\n')
                if line.startswith('data:'):
                    lines.append(line[5:].lstrip())
                elif not line:
                    consume(lines)
                    lines = []
            consume(lines)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'语音接口 HTTP {error.code}') from None
    if not audio or len(audio) % 2:
        raise RuntimeError('语音字节缺失或不完整')
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(audio)
    record = {'model':body['model'], 'voice':body['input']['voice'], 'rate':1,
              'textSha256':text_hash, 'duration':len(audio)/48000,
              'audioSha256':hashlib.sha256(audio).hexdigest(), 'completeStop':stopped,
              'eventTypes':sorted(event_types), 'sentences':sentences, 'usage':usage}
    metadata.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'scene':index,'duration':record['duration'],'sentenceCount':len(sentences),'stop':stopped}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', type=int)
    args = parser.parse_args()
    profile = credentials()
    scenes = json.loads((ROOT/'scenes.json').read_text(encoding='utf-8'))
    for index, scene in enumerate(scenes, 1):
        if args.only is None or args.only == index:
            synthesize(scene,index,profile['api_key'],profile['endpoints']['speech'])
    profile['api_key'] = None
