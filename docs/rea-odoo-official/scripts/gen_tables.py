import json, os
from collections import defaultdict, Counter

D = os.path.dirname(os.path.abspath(__file__))
MAN = json.load(open(f"{D}/manifest_index.json"))
MOD = json.load(open(f"{D}/model_index.json"))
RTE = json.load(open(f"{D}/route_index.json"))
FE  = json.load(open(f"{D}/frontend_index.json"))
SEC = json.load(open(f"{D}/security_index.json"))
CLS = json.load(open(f"{D}/class_index.json"))

routes_by_mod = Counter(r["module"] for r in RTE)
defines = defaultdict(list); extends = defaultdict(list)
for mn, i in MOD.items():
    for m in i["defined_in"]: defines[m].append(mn)
    for m in i["extended_in"]: extends[m].append(mn)
cls_by_mod = Counter(c["module"] for c in CLS)

def row(m):
    i = MAN[m]; f = FE.get(m, {}); s = SEC.get(m, {})
    return (m, (i["category"] or "-"), i["depth_from_base"], i["direct_dependents"],
            "yes" if i["auto_install"] else "-", len(defines.get(m, [])), len(extends.get(m, [])),
            cls_by_mod.get(m, 0), routes_by_mod.get(m, 0), f.get("components", 0),
            f.get("patches", 0), s.get("access_rows", 0), s.get("with_domain", 0))

HDR = ("| Module | Category | Depth | Dependents | Auto | Models defined | Models extended | Classes | Routes | OWL comp | patch() | ir.access | w/domain |\n"
       "|---|---|---|---|---|---|---|---|---|---|---|---|---|\n")
def table(mods):
    out = HDR
    for m in mods:
        r = row(m)
        out += "| `%s` | %s | %d | %d | %s | %d | %d | %d | %d | %d | %d | %d | %d |\n" % r
    return out

L = []
A = L.append
A("# 06 - Technical Reference Tables\n")
A("Generated from the Phase 1-3 indexes by `gen_tables.py`. Every column is a")
A("measured count, not an estimate.\n")
A("**Column meanings.** *Depth* is the longest dependency path to a module with")
A("no in-tree dependencies. *Dependents* counts modules naming this one in")
A("`depends`. *Auto* marks `auto_install: True`. *Models defined* counts models")
A("for which this module declares `_name`; *Models extended* counts models it")
A("reopens with `_inherit` only. *Classes* is the number of model classes in the")
A("module. *OWL comp* is `extends Component` occurrences and *patch()* is")
A("frontend patch calls (both regex-derived, so approximate). *ir.access* is")
A("security CSV rows and *w/domain* the subset carrying a record-rule domain.\n")

# ---- 1. applications ----
apps = sorted(m for m, i in MAN.items() if i["application"])
A("## 1. The 34 declared applications\n")
A("Modules with `application: True` — what appears as an installable app.\n")
A(table(apps))

# ---- 2. top hubs ----
hubs = [m for m, _ in sorted(((m, i["direct_dependents"]) for m, i in MAN.items()),
        key=lambda x: -x[1])[:40]]
A("\n## 2. Top 40 hub modules by direct dependents\n")
A("A change here has the widest blast radius.\n")
A(table(hubs))

# ---- 3. bridges ----
bridges = sorted((m for m, i in MAN.items()
                  if i["auto_install"] and not i["application"]
                  and len(extends.get(m, [])) > len(defines.get(m, []))
                  and i["depth_from_base"] > 2
                  and not m.startswith(("test", "l10n", "theme"))),
                 key=lambda m: -len(extends.get(m, [])))[:40]
A("\n## 3. Top 40 auto-install bridge modules\n")
A("`auto_install` modules that define or extend models, excluding tests,")
A("localizations, and themes. These exist only to reconcile two other modules;")
A("note how many define **zero** models of their own and operate purely by")
A("extension.\n")
A(table(bridges))

# ---- 4. biggest models ----
A("\n## 4. The 40 largest models by field count\n")
A("| Model | Fields | Rel | m2o | o2m | m2m | Computes | Constrains | Onchange | Ext by | Defined in |\n|---|---|---|---|---|---|---|---|---|---|---|")
for mn, i in sorted(MOD.items(), key=lambda x: -len(x[1]["fields"]))[:40]:
    rels = i["relations"]
    seen = set(); uniq = []
    for r in rels:
        k = (r["field"], r["type"], r["comodel"])
        if k in seen: continue
        seen.add(k); uniq.append(r)
    c = Counter(r["type"] for r in uniq)
    L.append("| `%s` | %d | %d | %d | %d | %d | %d | %d | %d | %d | %s |" % (
        mn, len(i["fields"]), len(uniq), c["Many2one"], c["One2many"], c["Many2many"],
        len(i["computes"]), len(i["constrains"]), len(i["onchanges"]),
        len(i["extended_in"]), ", ".join("`%s`" % x for x in i["defined_in"]) or "-"))
A("")

# ---- 5. most extended models ----
A("\n## 5. The 30 most-extended models\n")
A("How many distinct modules reopen each model with `_inherit`.\n")
A("| Model | Extended by | Fields | Computes | Abstract | Transient | Defined in |\n|---|---|---|---|---|---|---|")
for mn, i in sorted(MOD.items(), key=lambda x: -len(x[1]["extended_in"]))[:30]:
    L.append("| `%s` | %d | %d | %d | %s | %s | %s |" % (
        mn, len(i["extended_in"]), len(i["fields"]), len(i["computes"]),
        "yes" if i["is_abstract"] else "-", "yes" if i["is_transient"] else "-",
        ", ".join("`%s`" % x for x in i["defined_in"]) or "-"))
A("")

# ---- 6. state machines ----
A("\n## 6. Complete state-machine inventory\n")
A("Every non-test model carrying a `state` Selection with literal values, read")
A("from the Selection definition in declaration order. Declaration order is not")
A("necessarily transition order.\n")
A("| Model | Defined in | States |\n|---|---|---|")
sm = []
for mn, i in MOD.items():
    if mn.startswith(("test", "export")): continue
    if "state" in i["states"]:
        sm.append((mn, ", ".join("`%s`" % x for x in i["defined_in"]) or "-",
                   " -> ".join("`%s`" % v for v in i["states"]["state"])))
for r in sorted(sm):
    L.append("| `%s` | %s | %s |" % r)
A("")
A("\n### Secondary status fields\n")
A("Progress trackers that are not the primary lifecycle.\n")
A("| Model | Field | Values |\n|---|---|---|")
for mn, i in sorted(MOD.items()):
    if mn.startswith(("test", "export")): continue
    for f, vals in sorted(i["states"].items()):
        if f == "state": continue
        L.append("| `%s` | `%s` | %s |" % (mn, f, ", ".join("`%s`" % v for v in vals)))
A("")

# ---- 7. mixins ----
A("\n## 7. Mixin adoption\n")
A("Abstract models adopted via `_name` + `_inherit`, by number of adopting models.\n")
cnt = Counter()
for mn, i in MOD.items():
    for ab in i["inherits_abstract"]: cnt[ab] += 1
A("| Adopters | Mixin | Own fields | Abstract | Defined in |\n|---|---|---|---|---|")
for ab, n in cnt.most_common(35):
    i = MOD.get(ab)
    L.append("| %d | `%s` | %s | %s | %s |" % (
        n, ab, len(i["fields"]) if i else "?", "yes" if i and i["is_abstract"] else "-",
        ", ".join("`%s`" % x for x in i["defined_in"]) if i and i["defined_in"] else "-"))
A("")

# ---- 8. delegation ----
A("\n## 8. `_inherits` delegation (non-test)\n")
A("| Child model | Parent model | Link field | Child fields |\n|---|---|---|---|")
for mn, i in sorted(MOD.items()):
    if mn.startswith(("test", "export")): continue
    for d in i["delegates"]:
        L.append("| `%s` | `%s` | `%s` | %d |" % (mn, d["parent"], d["via"], len(i["fields"])))
A("")

# ---- 9. security ----
A("\n## 9. Security surface by module (top 30)\n")
A("`ir.access` rows. A row with a domain is a record rule; without, a plain ACL.\n")
A("| Module | Rows | With domain | ACL only | Operations observed |\n|---|---|---|---|---|")
for m, v in sorted(SEC.items(), key=lambda x: -x[1]["access_rows"])[:30]:
    ops = ", ".join("`%s`=%d" % (k or "(empty)", n)
                    for k, n in sorted(v["operations"].items(), key=lambda x: -x[1])[:5])
    L.append("| `%s` | %d | %d | %d | %s |" % (
        m, v["access_rows"], v["with_domain"], v["access_rows"] - v["with_domain"], ops))
A("")

# ---- 10. routes ----
A("\n## 10. HTTP surface by module (all 157 with controllers)\n")
A("| Module | Routes | http | jsonrpc | json2 | public | user | other auth | csrf=False | readonly |\n|---|---|---|---|---|---|---|---|---|---|")
by = defaultdict(list)
for r in RTE: by[r["module"]].append(r)
for m, rs in sorted(by.items(), key=lambda x: -len(x[1])):
    t = Counter(x["type"] for x in rs); a = Counter(x["auth"] for x in rs)
    other = len(rs) - a["public"] - a["user"]
    L.append("| `%s` | %d | %d | %d | %d | %d | %d | %d | %d | %d |" % (
        m, len(rs), t["http"], t["jsonrpc"], t["json2"], a["public"], a["user"], other,
        sum(1 for x in rs if x["csrf"] == "False"),
        sum(1 for x in rs if x["readonly"] and x["readonly"] != "False")))
A("")

# ---- 11. domain index ----
A("\n## 11. Module index by domain\n")
dom = defaultdict(list)
for m, i in MAN.items():
    dom[(i["category"] or "Uncategorized").split("/")[0]].append(m)
A("| Domain | Modules | Applications | Auto-install | With controllers | With static/src |\n|---|---|---|---|---|---|")
for c in sorted(dom, key=lambda x: -len(dom[x])):
    ms = dom[c]
    L.append("| %s | %d | %d | %d | %d | %d |" % (
        c, len(ms), sum(1 for m in ms if MAN[m]["application"]),
        sum(1 for m in ms if MAN[m]["auto_install"]),
        sum(1 for m in ms if MAN[m]["has_controllers"]),
        sum(1 for m in ms if MAN[m]["has_static_src"])))
A("")
A("\n## Reproduction\n")
A("```bash")
A("python3 -I build_indexes.py   # writes the 5 JSON indexes")
A("python3 -I gen_tables.py      # regenerates this document")
A("```")
A("\nBoth scripts take the addons root from the `ADDONS` constant and are")
A("idempotent. Running them against a different Odoo tree regenerates every")
A("table above for that version.")

out = os.path.normpath(os.path.join(D, "..", "06-reference-tables.md"))
open(out, "w").write("\n".join(L) + "\n")
print("wrote", out)
print("written")
