#!/usr/bin/env python3
"""Generate stage-select thumbnails from the full-res stage renders.

Reads stages/<stage>.png from the FightingGameEngine/Assets repo (raw
GitHub), downscales each to fit a 512x288 box (LANCZOS), encodes JPEG
q82 progressive, and uploads the result to stages/thumbs/<stage>.jpg in
the same repo via the GitHub Contents API (one commit per file).

The frontend (stageThumbUrl in src/lib/character-downloader.ts) derives
stages/thumbs/<def-basename>.jpg as the thumbnail URL, so new stages
just need a thumbs/<stage>.jpg dropped in (or a re-run of this script).
The full-res <stage>.png renders stay in the repo untouched — they are
the source art; the grid only ever fetches the small thumbs.

Usage:
    python3 scripts/gen-stage-thumbs.py [--dry-run]
Token comes from GITHUB_TOKEN env, or the token embedded in this web
repo's origin remote URL.
"""
import base64
import io
import json
import os
import re
import sys
import urllib.request

# Upstream Assets repo — override with ASSETS_GH_REPO to target the demo
# mirror repo (e.g. FightingGameEngine/DemoAssets).
REPO = os.environ.get('ASSETS_GH_REPO', 'FightingGameEngine/Assets')
BRANCH = 'main'
SRC_DIR = 'stages'
OUT_DIR = 'stages/thumbs'
BOX = (512, 288)
JPEG_Q = 82

# All stages in the manifest at generation time. Re-run after adding a
# stage (the loop skips stages whose .png download fails).
STAGES = [
    'Badda_Large_Stage', 'Bookshop', 'UIU_Campus', 'UIU_Campus_front',
    'UIU_Campus_Night', 'UIU_Fountain', 'UIU_Gallery', 'UIU_Side',
    'Unimart',
]

RAW_BASE = f'https://raw.githubusercontent.com/{REPO}/{BRANCH}/'
API_BASE = f'https://api.github.com/repos/{REPO}/contents/'


def get_token():
    tok = os.environ.get('GITHUB_TOKEN')
    if tok:
        return tok
    # Fall back to the token embedded in the web repo's origin remote.
    try:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out = os.popen(f'git -C {repo_root} remote get-url origin').read().strip()
        m = re.match(r'https://([^@]+)@', out)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


def http(url, token=None, data=None, method='GET'):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('User-Agent', 'stage-thumb-generator')
    if token:
        req.add_header('Authorization', f'token {token}')
    return urllib.request.urlopen(req, timeout=60)


def make_thumb(png_bytes):
    from PIL import Image
    im = Image.open(io.BytesIO(png_bytes))
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')
    im.thumbnail(BOX, Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True)
    return im.size, out.getvalue()


def main():
    dry = '--dry-run' in sys.argv
    token = get_token()
    if not token and not dry:
        print('ERROR: no GitHub token (env GITHUB_TOKEN or origin remote)')
        sys.exit(1)

    total_src = total_out = 0
    for name in STAGES:
        src_name = f'{name}.png'
        url = RAW_BASE + SRC_DIR + '/' + src_name
        try:
            png = http(url).read()
        except Exception as e:
            print(f'  SKIP {src_name}: download failed ({e})')
            continue
        (w, h), jpg = make_thumb(png)
        kb_src, kb_out = len(png) / 1024, len(jpg) / 1024
        total_src += kb_src
        total_out += kb_out
        print(f'{name:22s} {w}x{h}  {kb_src:8.1f} KB -> {kb_out:6.1f} KB'
              f'  ({kb_src / kb_out:4.0f}x smaller)')

        if dry:
            continue
        body = {
            'message': (
                f'Add stage-select thumbnail for {name} '
                f'({w}x{h} JPEG, generated from {src_name})'),
            'content': base64.b64encode(jpg).decode('ascii'),
            'branch': BRANCH,
        }
        req = http(
            API_BASE + f'{OUT_DIR}/{name}.jpg', token=token,
            data=json.dumps(body).encode('utf-8'),
            method='PUT')
        resp = json.loads(req.read())
        commit = resp.get('commit', {}).get('sha', '?')[:8]
        print(f'  PUSHED -> {OUT_DIR}/{name}.jpg  (commit {commit})')

    print(f'\nTOTAL: {total_src/1024:.1f} MB source -> '
          f'{total_out/1024:.1f} MB thumbs ({total_src/total_out:.0f}x)')


if __name__ == '__main__':
    main()
