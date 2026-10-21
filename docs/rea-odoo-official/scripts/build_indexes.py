"""Regenerate the three REA indexes for Odoo 20 addons. Idempotent."""
import ast, json, os, re, csv
from collections import defaultdict

ADDONS = "/usr/lib/python3/dist-packages/odoo/addons"
OUT = os.path.dirname(os.path.abspath(__file__))
REL = {"Many2one", "One2many", "Many2many", "Many2oneReference"}

def s(n):
    return n.value if isinstance(n, ast.Constant) and isinstance(n.value, str) else None
def strlist(n):
    if isinstance(n, ast.Constant) and isinstance(n.value, str): return [n.value]
    if isinstance(n, (ast.List, ast.Tuple)): return [v for v in (s(e) for e in n.elts) if v]
    return []

# ---------- 1. manifests ----------
man = {}
for name in sorted(os.listdir(ADDONS)):
    mp = os.path.join(ADDONS, name, "__manifest__.py")
    if not os.path.isfile(mp): continue
    try: d = ast.literal_eval(open(mp, encoding="utf-8").read())
    except Exception: continue
    if not isinstance(d, dict): continue
    man[name] = {
        "name": d.get("name"), "version": d.get("version"), "category": d.get("category"),
        "depends": sorted(d.get("depends") or []), "auto_install": d.get("auto_install", False),
        "application": bool(d.get("application")), "installable": d.get("installable", True),
        "license": d.get("license"), "summary": (d.get("summary") or "").strip()[:160],
        "assets_bundles": sorted((d.get("assets") or {}).keys()),
        "has_controllers": os.path.isdir(os.path.join(ADDONS, name, "controllers")),
        "has_static_src": os.path.isdir(os.path.join(ADDONS, name, "static", "src")),
        "has_models": os.path.isdir(os.path.join(ADDONS, name, "models")),
        "has_security": os.path.isdir(os.path.join(ADDONS, name, "security")),
    }
rd = defaultdict(set)
for m, i in man.items():
    for dep in i["depends"]: rd[dep].add(m)
for m in man: man[m]["direct_dependents"] = len(rd.get(m, ()))
memo = {}
def depth(m, stack=()):
    if m in memo: return memo[m]
    if m in stack: return 0
    deps = [d for d in man.get(m, {}).get("depends", []) if d in man]
    v = 0 if not deps else 1 + max(depth(d, stack + (m,)) for d in deps)
    memo[m] = v; return v
for m in man: man[m]["depth_from_base"] = depth(m)
json.dump(man, open(os.path.join(OUT, "manifest_index.json"), "w"), indent=1, sort_keys=True)

# ---------- 2. models ----------
models = {}; classes = []; st = defaultdict(int)
def rec(mn, mod, kind):
    m = models.setdefault(mn, {"defined_in": [], "extended_in": [], "delegates": [], "fields": {},
        "relations": [], "states": {}, "computes": [], "constrains": [], "onchanges": [], "ondelete": [],
        "inherits_abstract": [], "methods": defaultdict(list), "sql_constraints": [],
        "rec_name": None, "order": None, "table": None, "is_abstract": False, "is_transient": False, "auto": None})
    key = "defined_in" if kind == "define" else "extended_in"
    if mod not in m[key]: m[key].append(mod)
    return m

for module in sorted(man):
    mdir = os.path.join(ADDONS, module)
    for root, dirs, files in os.walk(mdir):
        dirs[:] = [d for d in dirs if d not in ("static", "i18n", "__pycache__", "data")]
        for fn in files:
            if not fn.endswith(".py"): continue
            path = os.path.join(root, fn)
            try: tree = ast.parse(open(path, encoding="utf-8").read())
            except Exception: continue
            for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
                base_txt = " ".join(ast.unparse(b) for b in cls.bases)
                if not any(k in base_txt for k in ("models.Model", "models.TransientModel",
                        "models.AbstractModel", "Model", "TransientModel", "AbstractModel")): continue
                st["classes"] += 1
                name = inherit = inherits = None
                attrs = {}; fields = {}; rels = []; states = {}
                computes = []; constrains = []; onchanges = []; ondeletes = []
                methods = defaultdict(list); sqlc = []
                for node in cls.body:
                    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                        tgt = node.targets[0].id
                        if tgt == "_name": name = s(node.value)
                        elif tgt == "_inherit": inherit = strlist(node.value)
                        elif tgt == "_inherits" and isinstance(node.value, ast.Dict):
                            inherits = {}
                            for k, v in zip(node.value.keys, node.value.values):
                                ks, vs = s(k), s(v)
                                if ks and vs: inherits[ks] = vs
                        elif tgt in ("_description","_order","_rec_name","_table","_auto","_parent_name"):
                            attrs[tgt] = s(node.value) if s(node.value) is not None else ast.unparse(node.value)
                        elif tgt == "_sql_constraints" and isinstance(node.value, ast.List):
                            for e in node.value.elts:
                                if isinstance(e, (ast.Tuple, ast.List)) and e.elts:
                                    cn = s(e.elts[0])
                                    if cn: sqlc.append(cn)
                        elif isinstance(node.value, ast.Call):
                            f = node.value.func; ftype = None
                            if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "fields":
                                ftype = f.attr
                            if ftype:
                                kw = {}
                                for k in node.value.keywords:
                                    if k.arg in ("comodel_name","inverse_name","relation","compute","inverse","related",
                                      "store","required","readonly","tracking","copy","index","ondelete","company_dependent",
                                      "check_company","precompute","recursive","string","group_expand","aggregator","domain","default"):
                                        try: kw[k.arg] = ast.unparse(k.value)
                                        except Exception: kw[k.arg] = "?"
                                pos = [s(a) for a in node.value.args]
                                fields[tgt] = {"type": ftype, **kw}
                                if ftype in REL:
                                    como = kw.get("comodel_name")
                                    if como: como = como.strip("'\"")
                                    if not como and pos and pos[0]: como = pos[0]
                                    if not como and len(pos) > 1 and pos[1]: como = pos[1]
                                    inv = kw.get("inverse_name")
                                    if not inv and len(pos) > 1 and pos[1] and ftype == "One2many": inv = pos[1]
                                    rels.append({"field": tgt, "type": ftype, "comodel": como,
                                        "inverse": (inv or "").strip("'\"") or None,
                                        "ondelete": (kw.get("ondelete") or "").strip("'\""),
                                        "required": kw.get("required") == "True", "store": kw.get("store"),
                                        "compute": (kw.get("compute") or "").strip("'\"") or None,
                                        "from_module": module})
                                    st["relations"] += 1
                                if ftype == "Selection" and tgt in ("state","status","stage_id","invoice_status",
                                        "payment_state","picking_status","delivery_status"):
                                    sel = None
                                    src = None
                                    if node.value.args and isinstance(node.value.args[0], (ast.List, ast.Tuple)):
                                        src = node.value.args[0]
                                    for k in node.value.keywords:
                                        if k.arg == "selection" and isinstance(k.value, (ast.List, ast.Tuple)): src = k.value
                                    if src is not None:
                                        sel = []
                                        for e in src.elts:
                                            if isinstance(e, (ast.Tuple, ast.List)) and e.elts:
                                                k0 = s(e.elts[0])
                                                if k0: sel.append(k0)
                                    if sel: states[tgt] = sel
                                st["fields"] += 1
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        for dec in node.decorator_list:
                            dt = ast.unparse(dec)
                            if "api.depends_context" in dt: continue
                            args = [s(a) for a in dec.args if s(a)] if isinstance(dec, ast.Call) else []
                            if "api.depends" in dt: computes.append({"method": node.name, "depends": args, "module": module}); st["computes"] += 1
                            elif "api.constrains" in dt: constrains.append({"method": node.name, "fields": args, "module": module}); st["constrains"] += 1
                            elif "api.onchange" in dt: onchanges.append({"method": node.name, "fields": args, "module": module})
                            elif "api.ondelete" in dt: ondeletes.append(node.name)
                        n = node.name
                        if n.startswith(("action_", "button_")): methods["actions"].append(n)
                        elif n in ("create","write","unlink","copy","_create","default_get","name_create","web_save"):
                            methods["crud_overrides"].append(n)
                        elif "_cron" in n: methods["cron"].append(n)
                target = name or (inherit[0] if inherit else None)
                if not target: continue
                m = rec(target, module, "define" if name else "extend")
                if name and inherit:
                    for ab in inherit:
                        if ab != name and ab not in m["inherits_abstract"]: m["inherits_abstract"].append(ab)
                if inherits:
                    for pm, fk in inherits.items():
                        e = {"parent": pm, "via": fk}
                        if e not in m["delegates"]: m["delegates"].append(e); st["delegation"] += 1
                m["fields"].update(fields); m["relations"] += rels
                for k, v in states.items(): m["states"].setdefault(k, v)
                m["computes"] += computes; m["constrains"] += constrains; m["onchanges"] += onchanges
                m["ondelete"] += ondeletes; m["sql_constraints"] += sqlc
                for k, v in methods.items(): m["methods"][k] += v
                if "AbstractModel" in base_txt: m["is_abstract"] = True
                if "TransientModel" in base_txt: m["is_transient"] = True
                amap = {"_order":"order","_rec_name":"rec_name","_table":"table","_auto":"auto"}
                for k, dst in amap.items():
                    if k in attrs and not m[dst]: m[dst] = attrs[k]
                classes.append({"module": module, "file": os.path.relpath(path, ADDONS), "class": cls.name,
                    "model": target, "kind": "define" if name else "extend", "_name": name,
                    "_inherit": inherit, "_inherits": inherits, "n_fields": len(fields), "n_rel": len(rels)})
for m in models.values():
    m["methods"] = {k: sorted(set(v)) for k, v in m["methods"].items()}
    m["ondelete"] = sorted(set(m["ondelete"])); m["sql_constraints"] = sorted(set(m["sql_constraints"]))
json.dump(models, open(os.path.join(OUT, "model_index.json"), "w"), indent=1, sort_keys=True, default=str)
json.dump(classes, open(os.path.join(OUT, "class_index.json"), "w"), indent=1, default=str)

# ---------- 3. web ----------
routes = []
for module in sorted(man):
    cdir = os.path.join(ADDONS, module, "controllers")
    if not os.path.isdir(cdir): continue
    for root, _, files in os.walk(cdir):
        for fn in files:
            if not fn.endswith(".py"): continue
            try: tree = ast.parse(open(os.path.join(root, fn), encoding="utf-8").read())
            except Exception: continue
            for node in ast.walk(tree):
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): continue
                for dec in node.decorator_list:
                    if not isinstance(dec, ast.Call): continue
                    if not ast.unparse(dec.func).endswith("route"): continue
                    paths = []
                    if dec.args:
                        a = dec.args[0]
                        if isinstance(a, ast.Constant) and isinstance(a.value, str): paths = [a.value]
                        elif isinstance(a, (ast.List, ast.Tuple)):
                            paths = [e.value for e in a.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                    kw = {k.arg: ast.unparse(k.value).strip("'\"") for k in dec.keywords if k.arg}
                    routes.append({"module": module, "handler": node.name, "paths": paths,
                        "file": os.path.relpath(os.path.join(root, fn), ADDONS),
                        "type": kw.get("type", "http"), "auth": kw.get("auth", "user"),
                        "methods": kw.get("methods", ""), "website": kw.get("website", ""),
                        "sitemap": kw.get("sitemap", ""), "readonly": kw.get("readonly", ""), "csrf": kw.get("csrf", "")})
json.dump(routes, open(os.path.join(OUT, "route_index.json"), "w"), indent=1)

# ---------- 4. frontend ----------
fe = {}
for module in sorted(man):
    sdir = os.path.join(ADDONS, module, "static", "src")
    if not os.path.isdir(sdir): continue
    d = {"js_files": 0, "components": 0, "patches": 0, "templates": 0,
         "registry_cats": defaultdict(int), "services": [], "scss": 0}
    for root, _, files in os.walk(sdir):
        for fn in files:
            p = os.path.join(root, fn)
            if fn.endswith(".js"):
                d["js_files"] += 1
                try: t = open(p, encoding="utf-8", errors="ignore").read()
                except Exception: continue
                d["components"] += len(re.findall(r"extends\s+Component\b", t))
                d["patches"] += len(re.findall(r"\bpatch\s*\(", t))
                for mt in re.finditer(r'registry\.category\(\s*["\']([^"\']+)["\']\s*\)', t):
                    d["registry_cats"][mt.group(1)] += 1
                for mt in re.finditer(r'category\(["\']services["\']\)\.add\(\s*["\']([^"\']+)["\']', t):
                    d["services"].append(mt.group(1))
            elif fn.endswith(".xml"):
                try: t = open(p, encoding="utf-8", errors="ignore").read()
                except Exception: continue
                d["templates"] += len(re.findall(r'<t\s+t-name=', t))
            elif fn.endswith((".scss", ".css")): d["scss"] += 1
    d["registry_cats"] = dict(d["registry_cats"])
    fe[module] = d
json.dump(fe, open(os.path.join(OUT, "frontend_index.json"), "w"), indent=1, sort_keys=True)

# ---------- 5. security ----------
# Scan every ir.access.csv anywhere under the addon, not just <module>/security/:
# 4 files live outside that directory and were missed by an earlier revision.
sec = defaultdict(lambda: {"access_rows": 0, "with_domain": 0,
                           "operations": defaultdict(int), "files": []})
for module in sorted(man):
    for root, dirs, files in os.walk(os.path.join(ADDONS, module)):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for fn in files:
            if fn != "ir.access.csv": continue
            path = os.path.join(root, fn)
            try: rr = list(csv.DictReader(open(path, encoding="utf-8", errors="ignore")))
            except Exception: continue
            e = sec[module]
            e["files"].append(os.path.relpath(path, ADDONS))
            for r in rr:
                e["access_rows"] += 1
                if (r.get("domain") or "").strip(): e["with_domain"] += 1
                e["operations"][(r.get("operation") or "").strip()] += 1
sec = {k: {**v, "operations": dict(v["operations"])} for k, v in sec.items()}
json.dump(sec, open(os.path.join(OUT, "security_index.json"), "w"), indent=1, sort_keys=True)

print("manifests:", len(man))
print("model classes:", st["classes"], "distinct models:", len(models))
print("fields:", st["fields"], "relations:", st["relations"])
print("computes:", st["computes"], "constrains:", st["constrains"], "delegations:", st["delegation"])
print("routes:", len(routes), "urls:", sum(len(r["paths"]) for r in routes))
print("modules with static/src:", len(fe))
print("modules with ir.access.csv:", len(sec))
print("ir.access rows:", sum(v["access_rows"] for v in sec.values()),
      "with domain:", sum(v["with_domain"] for v in sec.values()))
