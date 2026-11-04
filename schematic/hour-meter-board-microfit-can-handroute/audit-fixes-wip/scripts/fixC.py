"""Fix C: CAN/RS485 protectors and the AIN1 front end next to J1; Freerouting re-routes the fan-out nets inside
the J1 area while every other track stays locked. Usage: fixC.py PLACEMENT_NAME"""
import math, os, shutil, subprocess, sys, time, pcbnew, edit as E
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '..', 'fixC'); os.makedirs(WORK, exist_ok=True)
SRC = os.path.join(HERE, '..', 'fix', 'after-B.kicad_pcb')
FREEROUTING = os.path.expanduser('~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar')
T = ['RS485_A', 'RS485_B', 'CAN_H', 'CAN_L', 'RS232_TXD', 'RS232_RXD', 'AIN1_RAW', 'AIN1_MID', 'AIN1_ADC']
AIN = {'AIN1_RAW', 'AIN1_MID', 'AIN1_ADC'}
R1 = (62.0, 62.0, 81.0, 101.0)
R2 = (66.0, 97.0, 81.0, 110.0)
PLACEMENTS = {
    'routed': {'D701': (73.5, 68.62, 0), 'D1001': (73.5, 74.72, 180), 'C901': (73.9, 83.32, 0), 'R904': (73.9, 86.32, 0),
               'R901': (73.9, 89.32, 0), 'R902': (73.9, 92.32, 0)},
}
SETTINGS = """    (autoroute_settings
      (fanout off) (autoroute on) (postroute on) (vias on)
      (via_costs 80) (plane_via_costs 5) (start_ripup_costs 100) (start_pass_no 1)
      (layer_rule F.Cu (active on) (preferred_direction horizontal)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 1.4))
      (layer_rule B.Cu (active on) (preferred_direction vertical)
        (preferred_direction_trace_costs 2.5) (against_preferred_direction_trace_costs 4.0))
    )
"""
name = sys.argv[1] if len(sys.argv) > 1 else 'routed'
place = PLACEMENTS[name]
inside = lambda p, r: r[0] <= p[0] <= r[2] and r[1] <= p[1] <= r[3]
short = lambda t: t.GetNetname().split('/')[-1]


def prepare():
    b = pcbnew.LoadBoard(SRC)
    for ref, (x, y, rot) in place.items():
        E.move_fp(b, ref, x, y, rot, drag=False)
    def rip(t):
        n = short(t)
        if n not in T:
            return False
        pts = [E.P(t.GetPosition())] if t.GetClass() == 'PCB_VIA' else [E.P(t.GetStart()), E.P(t.GetEnd())]
        return any(inside(p, R1) for p in pts) or (n in AIN and any(inside(p, R2) for p in pts))
    print('ripped', E.delete_tracks(b, rip))
    # GND (or other) vias that now sit on a moved part's pads
    moved_pads = [p for ref in place for p in E.pads_of(b, ref).values()]
    def via_hits(t):
        if t.GetClass() != 'PCB_VIA':
            return False
        r = E.mm(t.GetWidth(pcbnew.F_Cu)) / 2
        for p in moved_pads:
            if p.GetNetname() != t.GetNetname() and p.GetEffectiveShape(pcbnew.F_Cu).Collide(t.GetPosition(), E.FM(r + 0.25)):
                return True
        return False
    print('vias removed under the moved parts', E.delete_tracks(b, via_hits))
    pre = os.path.join(WORK, f'{name}-pre.kicad_pcb')
    pcbnew.SaveBoard(pre, b, True)
    return pre


def route(pre):
    b = pcbnew.LoadBoard(pre)
    for t in b.GetTracks():
        t.SetLocked(True)
    for z in list(b.Zones()):
        if not z.GetIsRuleArea():
            b.Delete(z)
    dsn, ses = os.path.join(WORK, f'{name}.dsn'), os.path.join(WORK, f'{name}.ses')
    if not pcbnew.ExportSpecctraDSN(b, dsn):
        raise SystemExit('DSN export failed')
    text = open(dsn).read()
    at = text.index('    (boundary')
    open(dsn, 'w').write(text[:at] + SETTINGS + text[at:])
    if os.path.exists(ses):
        os.remove(ses)
    t0 = time.time()
    r = subprocess.run(['java', '-jar', FREEROUTING, '--gui.enabled=false', '-de', dsn, '-do', ses,
                        '--router.autorouter.max_passes=200', '-mt', '4', '--router.automatic_neckdown=false',
                        '--router.fanout.ripup_allowed=true'], capture_output=True, text=True, timeout=1800)
    print(f'freerouting {time.time() - t0:.0f} s, exit {r.returncode}')
    if not os.path.exists(ses):
        print(r.stdout[-2000:], r.stderr[-2000:]); raise SystemExit('no SES')
    return ses


def merge(pre, ses):
    b = pcbnew.LoadBoard(pre)
    was_locked = {t.m_Uuid.AsString(): t.IsLocked() for t in b.GetTracks()}
    for t in b.GetTracks():
        t.SetLocked(True)
    old = {}
    for t in b.GetTracks():
        key = (t.GetClass(), t.GetNetname(), E.P(t.GetStart()), E.P(t.GetEnd()), t.GetLayer())
        old[key] = t.m_Uuid.AsString()
    if not pcbnew.ImportSpecctraSES(b, ses):
        raise SystemExit('SES import failed')
    keep_new, junk = 0, []
    for t in list(b.GetTracks()):
        u = t.m_Uuid.AsString()
        if u in was_locked:
            continue
        key = (t.GetClass(), t.GetNetname(), E.P(t.GetStart()), E.P(t.GetEnd()), t.GetLayer())
        zero = t.GetClass() != 'PCB_VIA' and t.GetLength() == 0
        if short(t) not in T or key in old or zero:
            junk.append(t)
        else:
            keep_new += 1
            if t.GetClass() == 'PCB_VIA':
                v = pcbnew.Cast_to_PCB_VIA(t)
                v.SetDrill(v.GetWidth(pcbnew.F_Cu) // 2)
    for t in junk:
        b.Delete(t)
    for t in b.GetTracks():
        u = t.m_Uuid.AsString()
        t.SetLocked(was_locked.get(u, False))
    print(f'new items kept {keep_new}, junk dropped {len(junk)}')
    out = os.path.join(WORK, f'{name}-routed.kicad_pcb')
    E.fill(b)
    pcbnew.SaveBoard(out, b, True)
    return out


pre = prepare()
ses = route(pre)
out = merge(pre, ses)
for f in os.listdir(os.path.dirname(E.FIX)):
    if f.endswith(('.kicad_pro', '.kicad_sch', '.kicad_sym')) or f == 'sym-lib-table':
        shutil.copy(os.path.join(os.path.dirname(E.FIX), f), WORK)
# DRC needs the project next to the board: run it on a copy named like the project
proj = os.path.join(WORK, 'hour-meter-board-microfit-can-handroute.kicad_pcb')
shutil.copy(out, proj)
d = E.drc(proj)
print(E.summary(d))
for p in E.problems(d)[:30]:
    print('  ', p)
