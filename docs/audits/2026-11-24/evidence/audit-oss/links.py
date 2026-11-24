"""Check relative links/anchors in markdown and site html. Read-only."""
import os, re, sys

root = sys.argv[1]
ext = set()
bad = []


def slug(h):
    h = h.strip().lower()
    h = re.sub(r'[`*_]', '', h)
    h = re.sub(r'<[^>]+>', '', h)
    h = re.sub(r'[^\w\- ]', '', h, flags=re.UNICODE)
    return h.replace(' ', '-')


def md_anchors(path):
    a = set()
    for line in open(path, encoding='utf-8'):
        m = re.match(r'^#{1,6}\s+(.*)$', line)
        if m:
            a.add(slug(m.group(1)))
    return a


def html_ids(path):
    return set(re.findall(r'id="([^"]+)"', open(path, encoding='utf-8').read()))


files = []
for d, dn, fn in os.walk(root):
    if any(x in d for x in ('/target', 'node_modules', '/.git', '/dist')):
        continue
    for f in fn:
        if f.endswith('.md') or (f.endswith('.html') and '/docs/site' in d):
            files.append(os.path.join(d, f))

for p in files:
    s = open(p, encoding='utf-8').read()
    if p.endswith('.md'):
        links = re.findall(r'\]\(([^)\s]+)\)', s) + re.findall(r'(?:href|src)="([^"]+)"', s)
    else:
        links = re.findall(r'(?:href|src)="([^"]+)"', s)
    for l in links:
        if l.startswith(('http://', 'https://', 'mailto:')):
            ext.add(l)
            continue
        if l.startswith(('data:', 'javascript:')):
            continue
        target, _, frag = l.partition('#')
        target = target.split('?')[0]
        if target == '':
            tp = p
        else:
            tp = os.path.normpath(os.path.join(os.path.dirname(p), target))
        if not os.path.exists(tp):
            bad.append((p, l, 'MISSING FILE'))
            continue
        if frag and os.path.isfile(tp):
            if tp.endswith('.md'):
                anchors = md_anchors(tp)
                import urllib.parse
                fr = urllib.parse.unquote(frag)
                if fr not in anchors:
                    bad.append((p, l, 'ANCHOR? have: ' + ','.join(sorted(a for a in anchors if fr.strip('-')[:6] in a))))
            elif tp.endswith('.html'):
                if frag not in html_ids(tp):
                    bad.append((p, l, 'MISSING ANCHOR'))

print("BAD:")
for b in bad:
    print(' ', os.path.relpath(b[0], root), '->', b[1], '|', b[2])
print("EXTERNAL (%d):" % len(ext))
for e in sorted(ext):
    print(' ', e)
