#!/usr/bin/env python3
"""
Pont SYMBOLIQUE pour la vérification déterministe (lib/verify-deterministic.ts).
Lit {"a","b","mode"} sur stdin, répond {"equal":bool,"reason":str} ou {"error":str} sur stdout.
- mode "exact"      : a et b sont la MÊME expression (simplify(a-b)==0), nombres avec tolérance.
- mode "asymptotic" : a et b ont le MÊME ordre de grandeur (a/b → constante positive, sans n).
Aucune exécution réseau, juste sympy. Si sympy absent → {"error":"no-sympy"} (→ not_applicable propre).
"""
import sys, json, re

def fail(msg):
    print(json.dumps({"error": msg})); sys.exit(0)

try:
    import sympy
    from sympy.parsing.sympy_parser import (parse_expr, standard_transformations,
        implicit_multiplication_application, convert_xor)
except Exception:
    fail("no-sympy")

T = standard_transformations + (implicit_multiplication_application, convert_xor)

ASYMP = re.compile(r'(?:Θ|θ|Theta|big-?theta|O|o|Ω|ω|Omega|Big-?O)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)', re.I)

SUP = {'²':'**2','³':'**3','⁴':'**4','⁵':'**5','¹':'**1','⁰':'**0'}

def clean(s):
    s = (s or '').strip()
    s = re.sub(r'^[^=]{1,24}=(?!=)', '', s).strip()   # « E[X] = expr » → « expr » (RHS)
    m = ASYMP.search(s)            # « Θ(n log n) » → « n log n »
    if m: s = m.group(1)
    for k,v in SUP.items(): s = s.replace(k, v)
    s = (s.replace('·','*').replace('×','*').replace('ℓ','l').replace('√','sqrt')
           .replace('\\cdot','*').replace('\\log','log').replace('\\frac',''))
    s = re.sub(r'\bC\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)', r'binomial(\1,\2)', s)  # C(n,2)
    s = re.sub(r'\\binom\{([^}]*)\}\{([^}]*)\}', r'binomial(\1,\2)', s)
    s = re.sub(r'log[_ ]\{?(\w+)\}?\s*\(?\s*(\w+)\s*\)?', r'(log(\2)/log(\1))', s)  # log_3 9 → log(9)/log(3)
    s = s.replace('^','**')
    s = re.sub(r'\{|\}|\$|,$', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

# « ressemble à des maths » : au moins un chiffre, opérateur, ou fonction/symbole connu.
MATHY = re.compile(r'[0-9]|[+\-*/^]|\b(log|sqrt|binomial|exp|sin|cos|factorial)\b|[√ℓ²³·×]')

def parse(s):
    c = clean(s)
    if not MATHY.search(c):
        raise ValueError("non-math")
    return parse_expr(c, transformations=T, evaluate=True)

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        fail("bad-input")
    a_raw, b_raw, mode = data.get("a",""), data.get("b",""), data.get("mode","exact")
    if not a_raw or not b_raw: fail("empty")
    try:
        a, b = parse(a_raw), parse(b_raw)
        # symboles supposés POSITIFS (n, m, ℓ… domaines d'examen) → simplifications valides
        # (ex. (1/m)^l == 1/m^l). N'introduit pas de faux positif sur des expressions vraiment ≠.
        syms = a.free_symbols | b.free_symbols
        sub = {s: sympy.Symbol(s.name, positive=True) for s in syms}
        a, b = a.subs(sub), b.subs(sub)
    except Exception as e:
        fail("parse:" + str(e)[:60])
    try:
        if mode == "asymptotic":
            if a == 0 or b == 0:
                print(json.dumps({"equal": bool(a == b), "reason": "zero"})); return
            ratio = sympy.simplify(a / b)
            same = (len(ratio.free_symbols) == 0) and ratio.is_finite and ratio.is_positive
            print(json.dumps({"equal": bool(same), "reason": f"ratio={ratio}"})); return
        diff = sympy.simplify(a - b)
        if diff == 0:
            print(json.dumps({"equal": True, "reason": "diff=0"})); return
        # tolérance numérique (fractions/décimales)
        try:
            d = float(diff.evalf())
            scale = max(1.0, abs(float(a.evalf())))
            print(json.dumps({"equal": abs(d) <= 1e-6 * scale, "reason": f"diff={d:.3g}"})); return
        except Exception:
            print(json.dumps({"equal": False, "reason": f"diff={diff}"})); return
    except Exception as e:
        fail("compute:" + str(e)[:60])

main()
