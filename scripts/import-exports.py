#!/usr/bin/env python3
"""Turn customs export .xlsx files into data/customs/*.jsonl (git-ignored). Standard library only.

  python3 -I scripts/import-exports.py [--exclude-hs 3301,2906] file1.xlsx file2.xlsx ...

Keeps rows that name an importer and a destination. A value counts as USD only when the column says USD.
"""
import datetime, hashlib, json, pathlib, re, sys, zipfile
import xml.etree.ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
MAX_BYTES = 200 * 1024 * 1024  # uncompressed


def rows(path):
    z = zipfile.ZipFile(path)
    if sum(i.file_size for i in z.infolist()) > MAX_BYTES:
        raise ValueError("file too large")
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, e in ET.iterparse(z.open("xl/sharedStrings.xml")):
            if e.tag == NS + "si":
                ss.append("".join(t.text or "" for t in e.iter(NS + "t")))
                e.clear()
    sheet = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d*\.xml$", n))[0]
    for _, e in ET.iterparse(z.open(sheet)):
        if e.tag != NS + "row":
            continue
        out = []
        for j, c in enumerate(e.findall(NS + "c")):
            m, i = re.match(r"[A-Z]+", c.get("r") or ""), j
            if m:
                i = 0
                for ch in m.group(0):
                    i = i * 26 + ord(ch) - 64
                i -= 1
            out += [""] * (i + 1 - len(out))
            v = c.find(NS + "v")
            if c.get("t") == "s" and v is not None:
                out[i] = ss[int(v.text)]
            elif c.get("t") == "inlineStr":
                out[i] = "".join(t.text or "" for t in c.iter(NS + "t"))
            elif v is not None:
                out[i] = v.text or ""
        e.clear()
        yield out


def text(v):
    v = (v or "").strip()
    return None if v.upper() in ("", "NULL", "N/A") else v


def number(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if 0 < n < float("inf") else None


def month(v):
    iso = re.match(r"(\d{4})-(\d{2})-\d{2}", (v or "").strip())
    if iso:
        return "%s-%s" % iso.groups()
    m = re.match(r"([A-Za-z]{3})[a-z]*[ -](\d{4})$", (v or "").strip())
    if m and m.group(1).lower() in MONTHS:
        return "%s-%02d" % (m.group(2), MONTHS[m.group(1).lower()])
    return None


def main(args):
    exclude = ()
    if args[:1] == ["--exclude-hs"]:
        exclude, args = tuple(args[1].split(",")), args[2:]
    seen, out = set(), []
    for f in args:
        head = None
        try:
            for i, r in enumerate(rows(f)):
                if head is None:
                    if sum(1 for x in r if x) >= 6:
                        head = [x.strip().upper() for x in r]
                    continue
                d = dict(zip(head, r))
                pick = lambda *ks: next((text(d[k]) for k in ks if text(d.get(k))), None)
                importer = pick("CONSIGNEE_NAME_EN", "CONSIGNEE_NAME", "IMPORTER_NAME")
                # a US import manifest has a bill of lading and no destination column: one bill is one record
                bill = pick("BILL_OF_LADING") if "US_CLEARING_DISTRICT" in head else None
                if bill:
                    if bill in seen:
                        continue
                    seen.add(bill)
                dest, hs = ("USA" if bill else pick("DESTINATION_COUNTRY")), re.sub(r"\D", "", d.get("HS_CODE", ""))
                if not importer or not dest or len(hs) < 4 or (exclude and hs.startswith(exclude)):
                    continue
                rec = dict(importer=importer, supplier=pick("SHIPPER_NAME_EN", "SHIPPER_NAME", "SUPPLIER_NAME"), hs=hs,
                           description=pick("PRODUCT_DESCRIPTION", "HS_CODE_DESCRIPTION")[:300] if pick("PRODUCT_DESCRIPTION", "HS_CODE_DESCRIPTION") else None, origin=pick("ORIGIN_COUNTRY", "COUNTRY"), destination=dest,
                           value_usd=number(pick("TOTALVALUEUSD", "TOTALUSD")), quantity=number(pick("TOTALQUANTITY", "SUMOFQUANTITY", "QUANTITY")),
                           weight_kg=number(pick("NET_WEIGHT", "WEIGHT_IN_KG")), month=month(pick("MONTHYEAR", "ACTUAL_ARRIVAL_DATE")))
                key = bill and "bill:" + bill or hashlib.sha1(json.dumps(rec, sort_keys=True).encode()).hexdigest()
                if key in seen:  # the same record in two overlapping exports
                    continue
                seen.add(key)
                out.append(dict(rec, file="export-" + hashlib.sha1(pathlib.Path(f).name.encode()).hexdigest()[:8], line=i + 1))
        except Exception as err:
            print("skipped %s: %s" % (pathlib.Path(f).name, err), file=sys.stderr)
    dst = pathlib.Path("data/customs")
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "shipments.jsonl").write_text("".join(json.dumps(r) + "\n" for r in out))
    print("%d records from %d files at %s" % (len(out), len(args), datetime.datetime.now().isoformat(timespec="seconds")))


if __name__ == "__main__":
    main(sys.argv[1:])
