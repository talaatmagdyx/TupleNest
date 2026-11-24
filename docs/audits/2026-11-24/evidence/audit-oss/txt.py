import sys, re, html

for p in sys.argv[1:]:
    print("=========== " + p)
    s = open(p).read()
    s = re.sub(r'(?s)<(script|style).*?</\1>', '', s)
    s = re.sub(r'(?s)<!--.*?-->', '', s)
    s = re.sub(r'<a [^>]*href="([^"]+)"[^>]*>', r'[\1] ', s)
    s = re.sub(r'<(/?)(b|i|code|em|strong|span|kbd)( [^>]*)?>', '', s)
    s = re.sub(r'<[^>]+>', '\n', s)
    s = html.unescape(s)
    out = [re.sub(r'\s+', ' ', l).strip() for l in s.split('\n')]
    print('\n'.join(l[:420] for l in out if l))
