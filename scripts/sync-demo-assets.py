#!/usr/bin/env python3
"""sync-demo-assets.py — copy game content from the production Assets repo
into the demo mirror repo (FightingGameEngine/DemoAssets).

WHY
    The demo deployment (FightingGameEngine-Demo on Vercel) reads its roster
    from FightingGameEngine/DemoAssets instead of the production
    FightingGameEngine/Assets, so the two rosters can diverge. This script
    mirrors the game content over.

WHAT IT DOES
    1. clones DemoAssets (full clone, ~600 MB — its own history is kept)
    2. fetches the production Assets main branch (SEVERAL GB — the slow step;
       run it where disk and bandwidth are comfortable)
    3. `git checkout FETCH_HEAD -- <dirs>` merges Assets' copies of the
       requested directories into the DemoAssets worktree (staged):
         - MERGE semantics: DemoAssets-only files (e.g. the custom
           Masjid_Al_Mustafa stage) are NEVER deleted; colliding paths are
           overwritten with the Assets version.
         - Default dirs: chars/ charsDBZExtremeBotuden/ charsDC/
           charsGuiltyGear/ charsMARVEL/ stages/  (stages/ includes thumbs/)
         - --include-portraits adds portraits/ (the 256px select-screen PNGs)
         - --manifest also copies manifest.json, with every cdnBase rewritten
           to point at DemoAssets (and preserved JSON formatting)
    4. commits and pushes to DemoAssets main.

    manifest.json is NOT copied by default on purpose: the demo keeps its own
    curated roster. After a sync, run DemoAssets' own update-manifest.py to
    pick up newly copied characters — or re-run this script with --manifest
    (ideally together with --include-portraits, since the production manifest
    references portraits/) to adopt the full 362-char production roster.

USAGE
    python3 scripts/sync-demo-assets.py [--dry-run] [--include-portraits]
                                        [--manifest] [--keep-tmp]

    Token: GITHUB_TOKEN env var, or the token embedded in this web repo's
    origin remote URL (same convention as gen-stage-thumbs.py). The token
    needs Contents read on FightingGameEngine/Assets AND Contents read+write
    on FightingGameEngine/DemoAssets.

REPO OVERRIDES (env)
    ASSETS_GH_REPO     source repo  (default FightingGameEngine/Assets)
    DEMO_ASSETS_REPO   target repo  (default FightingGameEngine/DemoAssets)

DRY RUN
    Compares both repos' git trees via the GitHub API (no clone, no fetch)
    and reports exactly what a real sync would add / change / keep.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

SRC_REPO = os.environ.get('ASSETS_GH_REPO', 'FightingGameEngine/Assets')
DST_REPO = os.environ.get('DEMO_ASSETS_REPO', 'FightingGameEngine/DemoAssets')
BRANCH = 'main'

# Directory copy list — same as the default (see docstring); portraits is
# appended by flag, manifest.json handled separately.
COPY_DIRS = ['chars', 'charsDBZExtremeBotuden', 'charsDC', 'charsGuiltyGear',
             'charsMARVEL', 'stages']


def get_token():
    tok = os.environ.get('GITHUB_TOKEN')
    if tok:
        return tok
    # Fall back to the token embedded in the web repo's origin remote.
    try:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out = os.popen(f'git -C {repo_root} remote get-url origin').read().strip()
        if '@' in out:
            return out.split('https://')[1].split('@')[0]
    except Exception:
        pass
    return None


def api(url, token):
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'demo-assets-sync')
    if token:
        req.add_header('Authorization', f'token {token}')
    return json.load(urllib.request.urlopen(req, timeout=60))


def list_tree(repo, token):
    """Flatten a repo's main-branch tree: {path: blob_sha}. Warns on truncation."""
    d = api(f'https://api.github.com/repos/{repo}/git/trees/{BRANCH}?recursive=1',
            token)
    if d.get('truncated'):
        print('WARNING: tree listing truncated — dry-run numbers may be low')
    return {t['path']: t['sha'] for t in d.get('tree', []) if t['type'] == 'blob'}


def run(cmd, cwd=None):
    print(f'  $ {cmd if isinstance(cmd, str) else " ".join(cmd)}')
    r = subprocess.run(cmd, cwd=cwd)
    if r.returncode != 0:
        sys.exit(f'ERROR: command failed ({r.returncode}): {cmd}')


def dry_run(token):
    print(f'DRY RUN — comparing {SRC_REPO} -> {DST_REPO}\n')
    src = list_tree(SRC_REPO, token)
    dst = list_tree(DST_REPO, token)
    paths = COPY_DIRS + (['portraits'] if INCLUDE_PORTRAITS else [])
    grand_add = grand_chg = 0
    for p in paths:
        s = {k: v for k, v in src.items() if k == p or k.startswith(p + '/')}
        d = {k: v for k, v in dst.items() if k == p or k.startswith(p + '/')}
        add = set(s) - set(d)
        chg = {k for k in set(s) & set(d) if s[k] != d[k]}
        keep = len(set(d) - set(s))
        grand_add += len(add)
        grand_chg += len(chg)
        print(f'  {p:24s} add {len(add):5d}  overwrite {len(chg):5d}  '
              f'keep-own {keep:5d}')
    print(f'\n  manifest.json: '
          f'{"copied (cdnBase rewritten)" if COPY_MANIFEST else "NOT copied (demo keeps its curated roster)"}')
    print(f'  TOTAL new files: {grand_add}, overwritten: {grand_chg}')
    print('  DemoAssets-only files (custom stages/chars) are never deleted.\n'
          '  Re-run without --dry-run to perform the sync.')


def real_sync(token):
    work = tempfile.mkdtemp(prefix='demo-assets-sync-')
    if KEEP_TMP:
        print(f'tmp dir (kept): {work}')
    try:
        # 1. Clone the demo repo (keeps its own history).
        url = f'https://{token}@github.com/{DST_REPO}.git'
        run(['git', 'clone', url, work + '/demo'])
        demo = work + '/demo'

        # 2. Fetch the production repo (the multi-GB step).
        print(f'\nFetching {SRC_REPO} {BRANCH} — several GB, be patient...')
        run(['git', 'fetch', f'https://{token}@github.com/{SRC_REPO}.git',
             BRANCH, '--no-tags'], cwd=demo)
        src_sha = subprocess.run(['git', 'rev-parse', 'FETCH_HEAD'],
                                 cwd=demo, capture_output=True, text=True
                                 ).stdout.strip()[:10]

        # 3. Stage the merge-copy.
        paths = list(COPY_DIRS)
        if INCLUDE_PORTRAITS:
            paths.append('portraits')
        run(['git', 'checkout', 'FETCH_HEAD', '--'] + paths, cwd=demo)

        if COPY_MANIFEST:
            mpath = demo + '/manifest.json'
            with open(mpath) as f:
                man = json.load(f)
            for c in man.get('characters', []) + man.get('stages', []):
                if 'cdnBase' in c:
                    c['cdnBase'] = c['cdnBase'].replace(
                        f'{SRC_REPO}@main', f'{DST_REPO}@main')
            with open(mpath, 'w') as f:
                json.dump(man, f, indent=2, ensure_ascii=False)
            run(['git', 'add', 'manifest.json'], cwd=demo)
            print('  manifest.json copied with cdnBase rewritten to '
                  f'{DST_REPO}')

        # 4. Commit (neutral identity if none configured) and push.
        ident = subprocess.run(['git', 'config', 'user.email'], cwd=demo,
                               capture_output=True, text=True).stdout.strip()
        cmd = ['git', 'commit', '-m',
               f'Sync chars+stages from {SRC_REPO} @ {src_sha}']
        if not ident:
            cmd = ['git', '-c', 'user.name=demo-assets-sync',
                   '-c', 'user.email=sync@users.noreply.github.com'] + cmd
        run(cmd, cwd=demo)
        run(['git', 'push', 'origin', f'HEAD:{BRANCH}'], cwd=demo)

        stat = subprocess.run(['git', 'show', '--stat', '--oneline', 'HEAD'],
                              cwd=demo, capture_output=True, text=True
                              ).stdout.strip().splitlines()
        print('\n' + '\n'.join(stat[:1] + stat[-3:]))
        print('\nDone. Reminder for the demo Vercel project: set '
              'ASSETS_GH_REPO=' + DST_REPO)
    finally:
        if not KEEP_TMP:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    DRY = '--dry-run' in sys.argv
    INCLUDE_PORTRAITS = '--include-portraits' in sys.argv
    COPY_MANIFEST = '--manifest' in sys.argv
    KEEP_TMP = '--keep-tmp' in sys.argv
    TOKEN = get_token()
    if not TOKEN:
        sys.exit('ERROR: no GitHub token (set GITHUB_TOKEN or embed it in '
                 'this repo\'s origin remote URL)')
    if DRY:
        dry_run(TOKEN)
    else:
        real_sync(TOKEN)
