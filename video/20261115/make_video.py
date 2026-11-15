"""制作第二期更新视频，使用原始配音时间戳生成字幕及图解画面。"""
import argparse
import difflib
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
SCENES = json.loads((ROOT / 'scenes.json').read_text(encoding='utf-8'))
W, H = 1920, 1080
BG = '#101c2c'
PANEL = '#192a3e'
INK = '#eff5f7'
MUTED = '#a6b7c8'
TEAL = '#63e5ca'
BLUE = '#80baff'
GOLD = '#ffd592'
FONT = Path('C:/Windows/Fonts/msyh.ttc')
BOLD = Path('C:/Windows/Fonts/msyhbd.ttc')


def font(size, bold=False):
    return ImageFont.truetype(str(BOLD if bold else FONT), size)


def text(draw, xy, value, size=34, fill=INK, bold=False):
    draw.text(xy, str(value), font=font(size, bold), fill=fill)


def lines(draw, value, width, size):
    result, current = [], ''
    for char in value:
        if char == '\n':
            result.append(current)
            current = ''
        elif draw.textlength(current + char, font=font(size)) > width:
            result.append(current)
            current = char
        else:
            current += char
    if current:
        result.append(current)
    return result


def paragraph(draw, xy, value, width=480, size=32, fill=MUTED, spacing=16):
    x, y = xy
    for line in lines(draw, value, width, size):
        text(draw, (x, y), line, size, fill)
        y += size + spacing
    return y


def card(draw, box, title, detail='', accent=TEAL, title_size=36):
    x, y, right, bottom = box
    draw.rounded_rectangle(box, radius=24, fill=PANEL)
    draw.rounded_rectangle((x, y, x + 7, bottom), radius=3, fill=accent)
    title_bottom = paragraph(draw, (x + 30, y + 24), title, right-x-55, title_size, INK)
    if detail:
        paragraph(draw, (x + 30, title_bottom + 12), detail, right-x-60, 27, MUTED, 12)


def arrow(draw, start, end, fill=TEAL, width=5):
    draw.line((start, end), fill=fill, width=width)
    angle = math.atan2(end[1]-start[1], end[0]-start[0])
    points = [end]
    for offset in (2.65, -2.65):
        points.append((end[0]+22*math.cos(angle+offset), end[1]+22*math.sin(angle+offset)))
    draw.polygon(points, fill=fill)


def base(scene, phase):
    image = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1920, 9), fill=TEAL)
    text(draw, (90, 58), 'WECHAT MCP BRIDGE', 25, TEAL, True)
    text(draw, (1440, 58), '第二次更新 · 2026.11', 25, MUTED)
    text(draw, (90, 127), scene['chapter'], 28, TEAL)
    title_size = 57
    while draw.textlength(scene['title'], font=font(title_size, True)) > 1720:
        title_size -= 1
    text(draw, (86, 178), scene['title'], title_size, INK, True)
    draw.line((90, 278, 1830, 278), fill='#314359', width=2)
    for index, label in enumerate(scene['labels']):
        y = 363 + index * 145
        color = TEAL if phase == index else MUTED
        draw.ellipse((96, y+12, 108, y+24), fill=color)
        paragraph(draw, (130, y), label, 400, 32, color)
    text(draw, (90, 920), 'github.com/zxshm/wechat-mcp-bridge', 26, MUTED)
    return image, draw


def flow(draw, nodes, y=460, detail=None):
    gap = 56
    width = (1200-gap*(len(nodes)-1))//len(nodes)
    for n, title in enumerate(nodes):
        x = 610 + n * (width+gap)
        card(draw, (x, y, x+width, y+220), title, (detail or ['']*len(nodes))[n], BLUE if n==1 else TEAL, 34)
        if n < len(nodes)-1:
            arrow(draw, (x+width+8, y+110), (x+width+gap-9, y+110))


def visual(index, phase):
    scene = SCENES[index]
    image, d = base(scene, phase)
    if index in (0, 17):
        for row, (title, body) in enumerate([
            ('聊天主动同步', '自定义指令 → 固定程序 → 微信 MCP'),
            ('百兆文件直传', '云端原字节 → Minihome → 完整附件'),
            ('运行进展可追溯', '持久配置、上传偏移、发送回执与阶段计时')]):
            card(d, (610, 327+row*178, 1815, 480+row*178), title, body, TEAL if row==phase else BLUE)
    elif index == 1:
        card(d, (610, 335, 1120, 810), '原小弟聊天', '用户：请整理这次更新\n\n小弟：这是完整的更新说明……')
        card(d, (1260, 335, 1815, 810), '本人微信', '收到同一轮问题\n\n收到同一轮完整回答', BLUE)
        arrow(d, (1145, 570), (1234, 570))
        text(d, (650, 848), '流程示意 · 同一聊天延续任务上下文', 28, MUTED)
    elif index in (2, 4):
        card(d, (610, 332, 1815, 850), '原小弟 · 自定义指令', accent=TEAL)
        commands = ['每轮普通问答发布后，执行本轮微信同步。', '读取原消息 ID、正文和作者。', '调用固定同步程序，按顺序入队。', '完整等待真实返回，保存发送结果。', '临时缓存缺失时，从持久配置恢复程序。']
        for row, command in enumerate(commands):
            text(d, (650, 450+row*72), command, 31, TEAL if row==phase else INK)
    elif index == 3:
        flow(d, ['发布回答', '读取核验', '顺序入队'], 448, ['取得真实消息 ID', '原文、作者与记录', '用户问题 → 助手回答'])
        text(d, (665, 770), 'MCP 负责调用接口，Minihome 负责实际发送', 32, MUTED)
    elif index == 5:
        flow(d, ['持久配置', '恢复程序', '继续同步'], 448, ['保存完整固定程序', '恢复微信事件索引', '新问答实际发送'])
        card(d, (610, 720, 1815, 865), '两类真实验证', '无缓存恢复整轮 48.90 秒，后续连续问答整轮 20.82 秒')
    elif index == 6:
        flow(d, ['任意设备', '同一小弟', 'Linux 桥'], 445, ['客户端 / 浏览器', '云端完成同步调用', '持续处理微信收发'])
        text(d, (665, 780), 'Windows 用于开发与管理，数据走云端和 Linux', 31, MUTED)
    elif index == 7:
        flow(d, ['微信来信', '接收任务', '微信回复'], 400, ['新本人事件', '读取与生成回答', '沿用原会话上下文'])
        card(d, (610, 700, 1815, 865), '原聊天保留来信与回复镜像', 'GPT-6.1 Sol · 中等推理强度', BLUE)
    elif index == 8:
        for n, (title, body) in enumerate([('参考图片', '查看与理解'), ('文档资料', '读取与处理'), ('生成文件', '返回微信')]):
            x = 610+n*415
            card(d, (x, 392, x+375, 810), title, body, BLUE if n==1 else TEAL)
            d.rounded_rectangle((x+93, 550, x+280, 740), radius=15, outline=TEAL, width=4)
            for offset in (0, 1, 2):
                d.line((x+125, 603+offset*40, x+247, 603+offset*40), fill=MUTED, width=4)
    elif index == 9:
        flow(d, ['小弟云端', 'Minihome', '微信附件'], 425, ['Library 原始文件', '落盘、重组、核对', '完整上传微信 CDN'])
        text(d, (650, 755), 'HTTPS 原始二进制字节传输', 36, TEAL)
        text(d, (650, 815), '完整文件交付，接收后按原格式打开', 30, MUTED)
    elif index == 10:
        text(d, (630, 335), '100,002,422 字节 PDF', 44, INK, True)
        d.rounded_rectangle((630, 450, 1690, 590), radius=20, fill=TEAL)
        d.rounded_rectangle((1705, 450, 1820, 590), radius=20, fill=BLUE)
        text(d, (680, 495), '第 1 段 · 90,000,000 字节', 36, BG, True)
        text(d, (1280, 625), '+ 10,002,422 字节', 30, BLUE)
        arrow(d, (1210, 652), (1210, 720))
        card(d, (630, 745, 1820, 875), '重组成一个完整 PDF', '总大小一致 · SHA-256 一致')
    elif index == 11:
        text(d, (630, 340), '第 1 段 · 90,000,000 字节', 39, INK, True)
        d.rounded_rectangle((630, 455, 1815, 590), radius=18, fill=PANEL)
        d.rounded_rectangle((630, 455, 903, 590), radius=18, fill=TEAL)
        text(d, (655, 492), '已落盘', 30, BG, True)
        text(d, (980, 492), '从偏移继续补传剩余字节', 34, INK)
        card(d, (630, 680, 1815, 865), '断点 20,709,376 字节', '补传 69,290,624 字节，继续原上传编号和原分段', BLUE)
    elif index == 12:
        rows = [('第 1 段剩余补传', 85.847, TEAL), ('第 2 段上传', 15.556, BLUE), ('重组与核对', 5.307, GOLD), ('微信 CDN 上传', 77.916, TEAL), ('文件消息提交', .499, BLUE)]
        for row, (label, value, color) in enumerate(rows):
            y = 350+row*99
            text(d, (620, y), label, 28, MUTED)
            d.rounded_rectangle((980, y+3, 980+max(8, value/90*620), y+43), radius=7, fill=color)
            text(d, (1640, y-2), f'{value:.2f} s', 30, INK, True)
        text(d, (625, 875), '真实云端 PDF · 完整摘要一致 · 首次发送成功', 29, TEAL)
    elif index == 13:
        flow(d, ['同步启动', '工具往返', '微信发送'], 405, ['模型准备与取消息', '调度、连接与接口', '文字约 0.4–0.6 秒'])
        card(d, (610, 700, 1815, 865), '每一段分别计时', '客户端调用等待与服务端实际处理分别记录', BLUE)
    elif index == 14:
        card(d, (610, 332, 1815, 487), '独立读取并行', '完整消息、上下文与相关记录并行准备')
        card(d, (610, 512, 1815, 667), '一次完成服务端准备', '来源观察 + 完整历史核查 + 首次预占', BLUE)
        card(d, (610, 692, 1815, 865), '减少调用，提前刷新', '每轮 16 → 12 次工具调用；公开验证密钥后台刷新', GOLD)
    elif index == 15:
        text(d, (625, 332), '20.82 秒', 108, TEAL, True)
        text(d, (1230, 403), '连续问答样本 · 整轮', 32, MUTED)
        d.rounded_rectangle((630, 535, 1815, 635), radius=18, fill=BLUE)
        d.rounded_rectangle((630, 535, 879, 635), radius=18, fill=TEAL)
        text(d, (645, 563), '回答 4.37s', 29, BG, True)
        text(d, (980, 563), '发布后同步 16.45s', 33, BG, True)
        card(d, (630, 710, 1815, 870), '入队工具 4.77s / 2.68s', '对应 Minihome 实际处理 36ms / 37ms', BLUE)
    elif index == 16:
        flow(d, ['Linux 服务', 'HTTPS + MCP', '聊天指令'], 415, ['微信桥 + 文件接收', '本人微信与连接认证', '绑定原聊天同步职责'])
        card(d, (610, 720, 1815, 865), '公开代码与部署示例', '配置模板、systemd 服务、大文件工具与更新说明', BLUE)
    return image


def ass_time(seconds):
    value = round(seconds*100)
    return f'{value//360000}:{value//6000%60:02d}:{value//100%60:02d}.{value%100:02d}'


def srt_time(seconds):
    value = round(seconds*1000)
    return f'{value//3600000:02d}:{value//60000%60:02d}:{value//1000%60:02d},{value%1000:03d}'


def normalized(value):
    return ''.join(x.lower() for x in value if x.isalnum())


def captions(scene, metadata, offset):
    spoken, times = '', []
    for sentence in metadata['sentences'].values():
        for word in sentence['words']:
            chars = normalized(word['text'])
            for char in chars:
                spoken += char
                times.append((word['begin_time']/1000, word['end_time']/1000))
    source = normalized(scene['speech'])
    matcher = difflib.SequenceMatcher(None, source, spoken, autojunk=False)
    alignment = {}
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            alignment[block.a+k] = times[block.b+k]
    coverage = len(alignment)/max(1, len(source))
    if coverage < .93:
        raise ValueError(f'字幕与语音时间戳匹配不足 {coverage:.3f}')
    pieces = []
    for phrase in re.findall(r'[^，。！？；、]+[，。！？；、]?', scene['speech']):
        while len(phrase) > 27:
            pieces.append(phrase[:24])
            phrase = phrase[24:]
        if phrase:
            pieces.append(phrase)
    cursor, results = 0, []
    for piece in pieces:
        count = len(normalized(piece))
        matched = [alignment[i] for i in range(cursor, cursor+count) if i in alignment]
        cursor += count
        if not matched:
            raise ValueError('字幕缺少可用时间戳')
        results.append([offset+matched[0][0], offset+matched[-1][1], piece.rstrip('，。；、')])
    for index, caption in enumerate(results):
        next_start = results[index+1][0] if index+1 < len(results) else offset+metadata['duration']
        caption[1] = min(next_start-.02, max(caption[1]+.12, caption[0]+.25))
    return results, coverage


def build(render=True):
    frames = ROOT / 'frames'
    clips = ROOT / 'clips'
    frames.mkdir(exist_ok=True)
    clips.mkdir(exist_ok=True)
    caption_rows, manifest = [], []
    offset = 0
    for index, scene in enumerate(SCENES):
        number = index+1
        audio = ROOT/'audio'/f'{number:02}.wav'
        metadata = json.loads(audio.with_suffix('.json').read_text(encoding='utf-8'))
        if hashlib.sha256(scene['speech'].encode()).hexdigest() != metadata['textSha256']:
            raise ValueError('配音文字已变化，需要重新生成对应音频')
        duration = math.ceil(metadata['duration']*30)/30
        rows, coverage = captions(scene, metadata, offset)
        caption_rows.extend(rows)
        for phase in range(3):
            path = frames/f'{number:02}-{phase}.png'
            visual(index, phase).save(path)
        frame_list = clips/f'{number:02}.txt'
        entries = []
        for phase in range(3):
            entries += [f"file '{(frames/f'{number:02}-{phase}.png').as_posix()}'", f'duration {duration/3:.8f}']
        entries.append(f"file '{(frames/f'{number:02}-2.png').as_posix()}'")
        frame_list.write_text('\n'.join(entries)+'\n', encoding='utf-8')
        output = clips/f'{number:02}.mp4'
        if render and not output.exists():
            subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(frame_list),'-i',str(audio),'-vf','fps=30,format=yuv420p','-af','apad','-t',f'{duration:.8f}','-c:v','libx264','-preset','fast','-crf','20','-threads','4','-c:a','aac','-b:a','192k',str(output)],check=True)
        manifest.append({'scene':number,'title':scene['title'],'start':offset,'duration':duration,'captionCoverage':coverage,'audioSha256':metadata['audioSha256']})
        offset += duration
        print(f'场景 {number:02} 完成，字幕匹配 {coverage:.1%}',flush=True)
    ass = '''[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,43,&H00F5F7F9,&H00FFFFFF,&H002C1C10,&H002C1C10,0,0,0,0,100,100,1,0,3,14,0,2,80,80,47,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    srt=[]
    for number, (start,end,value) in enumerate(caption_rows,1):
        ass += f'Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{value}\n'
        srt.append(f'{number}\n{srt_time(start)} --> {srt_time(end)}\n{value}\n')
    (ROOT/'subtitles.ass').write_text(ass,encoding='utf-8-sig')
    (ROOT/'subtitles.srt').write_text('\n'.join(srt),encoding='utf-8-sig')
    (ROOT/'render-manifest.json').write_text(json.dumps({'duration':offset,'voice':'longanlingxi_v3.1','scenes':manifest},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    # 封面使用视频相同视觉语言，保留手机端可读字号。
    cover=Image.new('RGB',(1920,1080),BG)
    d=ImageDraw.Draw(cover)
    d.rectangle((0,0,1920,12),fill=TEAL)
    text(d,(105,105),'WECHAT MCP BRIDGE · 第二次更新',40,TEAL,True)
    text(d,(100,260),'让微信接上',116,INK,True)
    text(d,(100,425),'Dot 的工作流',116,INK,True)
    text(d,(110,655),'自定义指令同步 · 云端百兆文件直传',49,TEAL,True)
    card(d,(110,805,1810,970),'客户端提问，微信看结果','持久运行 / 90 MB 分段与续传 / 分阶段延迟追踪',BLUE)
    cover.save(ROOT/'cover.jpg',quality=96)
    cover_four_three=Image.new('RGB',(1440,1080),BG)
    cover_four_three.paste(cover.resize((1440,810)),(0,135))
    cover_four_three.save(ROOT/'cover-4x3.jpg',quality=96)
    if not render:
        return
    (clips/'all.txt').write_text('\n'.join(f"file '{(clips/f'{n:02}.mp4').as_posix()}'" for n in range(1,19))+'\n',encoding='utf-8')
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(clips/'all.txt'),'-c','copy',str(clips/'joined.mp4')],check=True)
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(clips/'joined.mp4'),'-vf','ass=subtitles.ass','-af','loudnorm=I=-16:TP=-1.5:LRA=9','-c:v','libx264','-preset','fast','-crf','20','-threads','6','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart',str(ROOT/'wechat-dot-update-20261115.mp4')],cwd=ROOT,check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--preview',action='store_true')
    build(render=not parser.parse_args().preview)
