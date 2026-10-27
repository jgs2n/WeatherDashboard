"""Compare backtest metrics under different truth definitions.

Reads the compact per-snapshot CSVs written by ``backtest.py --snapshots-csv``
(one per truth variant) and prints/writes a side-by-side report of the
metrics a threshold-tuning pass would lean on: rain false alarms (overall and
by radar dBZ bin), presence, intensity, precip start/end timing (overall and
by trend.method), and label hygiene (truth source mix, lag, how often the
+10/+20/+30 labels are identical).

Usage (from weather_benchmark/):
    python truth_compare.py legacy=runs/legacy.csv v2=runs/v2.csv v2+mrms=runs/v2_mrms.csv \\
        --out reports/truth_compare_2026-10-25.txt --json reports/truth_compare_2026-10-25.json
"""

import argparse
import json
import sys

import numpy as np
import pandas as pd

DRY = {'dry', '', 'nan', 'None'}
DBZ_BINS = [(-1e9, 22, '<22'), (22, 25, '22-24'), (25, 28, '25-27'),
            (28, 35, '28-34'), (35, 1e9, '>=35')]
METHODS = ['edge', 'slope', 'om15', 'consensus', 'edge-horizon', 'slope-horizon']


def load(path):
    df = pd.read_csv(path, low_memory=False)
    df['fcst_rain'] = ~df['precip_phenomenon'].astype(str).isin(DRY)
    for c in ['obs_precip_active'] + [f'precip_active_+{m}' for m in (10, 20, 30, 45, 60)]:
        if c in df.columns:
            df[c] = df[c].map({True: True, False: False, 'True': True, 'False': False})
    return df


def pct(n, d):
    return round(100.0 * n / d, 1) if d else None


def rain_block(df):
    t = df[df['obs_precip_active'].notna()]
    obs = t['obs_precip_active'].astype(bool)
    f = t['fcst_rain']
    fa = int((f & ~obs).sum())
    hit = int((f & obs).sum())
    miss = int((~f & obs).sum())
    calls = int(f.sum())
    out = {
        'n_truth': int(len(t)),
        'n_no_truth': int(len(df) - len(t)),
        'obs_rain_rate_pct': pct(int(obs.sum()), len(t)),
        'rain_fa_pct_of_polls': pct(fa, len(t)),     # = backtest rain_false_alarm_pct
        'rain_miss_pct_of_polls': pct(miss, len(t)),
        'rain_call_precision_pct': pct(hit, calls),
        'rain_pod_pct': pct(hit, hit + miss),
        'rain_calls': calls,
    }
    bins = {}
    dbz = pd.to_numeric(t['radar_dbz'], errors='coerce')
    for lo, hi, name in DBZ_BINS:
        sel = f & (dbz >= lo) & (dbz < hi)
        if name == '<22':
            sel = f & ((dbz < hi) | dbz.isna())
        n = int(sel.sum())
        bins[name] = {'calls': n, 'fa': int((sel & ~obs).sum()),
                      'precision_pct': pct(int((sel & obs).sum()), n)}
    out['by_dbz'] = bins
    return out


def intensity_block(df):
    i = df['intensity_category'].dropna()
    return {'n': int(len(i)),
            'correct_pct': pct(int((i == 'correct').sum()), len(i)),
            'understated_pct': pct(int((i == 'understated').sum()), len(i)),
            'overstated_pct': pct(int((i == 'overstated').sum()), len(i))}


_DISPLAYED_SEV = {'drizzle': 1, 'light rain': 1, 'light snow': 1, 'rain': 2, 'snow': 2,
                  'heavy rain': 3, 'heavy snow': 3}
_OBS_SEV = {'drizzle': 1, 'rain': 2, 'shower': 2, 'snow': 2, 'freezing_precip': 2,
            'heavy_rain': 3, 'heavy_snow': 3, 'thunderstorm': 4}


def intensity_displayed_block(df):
    """Intensity graded on the tier the user SAW (displayed_condition), not
    precip_phenomenon — the scorer's default axis disagrees with the display
    on ~1/3 of precip polls ('Light Rain' shown, phenomenon 'rain')."""
    i = df[df['intensity_category'].notna()]
    disp = i['displayed_condition'].astype(str).str.lower()
    f = disp.map(lambda d: 4 if 'thunder' in d else _DISPLAYED_SEV.get(d))
    o = i['obs_condition'].map(_OBS_SEV).fillna(2)
    thunder = i['obs_thunder'].astype(str).str.lower().eq('true')
    o = o.where(~thunder, 4)
    ok = f.notna()
    f, o = f[ok], o[ok]
    n = int(len(f))
    return {'n': n, 'correct_pct': pct(int((f == o).sum()), n),
            'understated_pct': pct(int((f < o).sum()), n),
            'overstated_pct': pct(int((f > o).sum()), n)}


def presence_block(df):
    p = df['presence_category'].dropna()
    w = df['wording_category'].dropna()
    return {'n': int(len(p)),
            'presence_fa_pct': pct(int((p == 'false_alarm').sum()), len(p)),
            'presence_miss_pct': pct(int((p == 'miss').sum()), len(p)),
            'wording_correct_pct': pct(int((w == 'correct').sum()), len(w))}


def _err(series):
    e = pd.to_numeric(series, errors='coerce').dropna()
    if e.empty:
        return {'n': 0, 'mae': None, 'median_abs': None, 'bias': None}
    return {'n': int(len(e)), 'mae': round(float(e.abs().mean()), 1),
            'median_abs': round(float(e.abs().median()), 1),
            'bias': round(float(e.mean()), 1)}       # + = actual later than predicted


def timing_block(df):
    out = {'start': _err(df['precip_start_error_min']), 'end': _err(df['precip_end_error_min']),
           'by_method': {}}
    for m in METHODS:
        sub = df[df['trend_method'] == m]
        if len(sub):
            out['by_method'][m] = {'start': _err(sub['precip_start_error_min']),
                                   'end': _err(sub['precip_end_error_min'])}
    return out


def hygiene_block(df):
    src = df['truth_source'].fillna('none').value_counts().to_dict()
    lead_src = {f'+{m}': df[f'truth_source_+{m}'].fillna('none').value_counts().to_dict()
                for m in (10, 20, 30, 45, 60) if f'truth_source_+{m}' in df.columns}
    lag = pd.to_numeric(df['truth_lag_min'], errors='coerce').dropna()
    a, b, c = (df[f'precip_active_+{m}'] for m in (10, 20, 30))
    both = a.notna() & b.notna() & c.notna()
    identical = int((both & (a == b) & (b == c)).sum())
    # Identical labels are expected when nothing changes; what matters is
    # whether they differ around precip changes. Count the wet cases.
    wet = both & (a.fillna(False).astype(bool) | b.fillna(False).astype(bool) | c.fillna(False).astype(bool))
    wet_identical = int((wet & (a == b) & (b == c)).sum())
    return {
        'current_source_counts': {k: int(v) for k, v in src.items()},
        'lead_source_counts': {k: {kk: int(vv) for kk, vv in v.items()} for k, v in lead_src.items()},
        'current_lag_min': ({'median': float(lag.median()), 'p90': float(lag.quantile(0.9)),
                             'min': float(lag.min()), 'max': float(lag.max())} if len(lag) else None),
        'leads_10_20_30_identical_pct': pct(identical, int(both.sum())),
        'leads_10_20_30_identical_when_any_wet_pct': pct(wet_identical, int(wet.sum())),
    }


def summarize(df):
    return {'n_snapshots': int(len(df)), 'rain': rain_block(df), 'presence': presence_block(df),
            'intensity': intensity_block(df),
            'intensity_displayed': intensity_displayed_block(df), 'timing': timing_block(df),
            'hygiene': hygiene_block(df)}


def per_city(df):
    rows = {}
    for city, sub in df.groupby('location'):
        r = rain_block(sub)
        i = intensity_block(sub)
        rows[city] = {'n_truth': r['n_truth'], 'rain_fa_pct': r['rain_fa_pct_of_polls'],
                      'rain_precision_pct': r['rain_call_precision_pct'], 'pod_pct': r['rain_pod_pct'],
                      'intensity_n': i['n'], 'intensity_correct_pct': i['correct_pct'],
                      'intensity_under_pct': i['understated_pct'],
                      'start_mae': _err(sub['precip_start_error_min'])['mae'],
                      'source_counts': sub['truth_source'].fillna('none').value_counts().to_dict()}
    return rows


def fmt(v, w=8):
    return f'{"-" if v is None else v:>{w}}'


def render(results, cities):
    names = list(results)
    L = []
    hdr = f'{"":38}' + ''.join(f'{n:>18}' for n in names)

    def row(label, getter):
        vals = []
        for n in names:
            try:
                vals.append(getter(results[n]))
            except (KeyError, TypeError):
                vals.append(None)
        L.append(f'{label:38}' + ''.join(fmt(v, 18) for v in vals))

    L.append('POOLED (all cities)')
    L.append(hdr)
    row('snapshots', lambda r: r['n_snapshots'])
    row('with current truth', lambda r: r['rain']['n_truth'])
    row('observed rain rate %', lambda r: r['rain']['obs_rain_rate_pct'])
    L.append('')
    L.append('Rain')
    row('  rain FA % of polls (backtest metric)', lambda r: r['rain']['rain_fa_pct_of_polls'])
    row('  rain miss % of polls', lambda r: r['rain']['rain_miss_pct_of_polls'])
    row('  rain-call precision %', lambda r: r['rain']['rain_call_precision_pct'])
    row('  rain POD %', lambda r: r['rain']['rain_pod_pct'])
    for _, _, b in DBZ_BINS:
        row(f'  precision, calls at {b} dBZ', lambda r, b=b: r['rain']['by_dbz'][b]['precision_pct'])
        row(f'     (n calls {b})', lambda r, b=b: r['rain']['by_dbz'][b]['calls'])
    row('  presence FA %', lambda r: r['presence']['presence_fa_pct'])
    row('  presence miss %', lambda r: r['presence']['presence_miss_pct'])
    row('  wording correct %', lambda r: r['presence']['wording_correct_pct'])
    L.append('')
    L.append('Intensity (both sides precip)')
    row('  n', lambda r: r['intensity']['n'])
    row('  correct %', lambda r: r['intensity']['correct_pct'])
    row('  understated %', lambda r: r['intensity']['understated_pct'])
    row('  overstated %', lambda r: r['intensity']['overstated_pct'])
    L.append('Intensity graded on the DISPLAYED tier (Light Rain=1, Rain=2, Heavy=3)')
    row('  correct %', lambda r: r['intensity_displayed']['correct_pct'])
    row('  understated %', lambda r: r['intensity_displayed']['understated_pct'])
    row('  overstated %', lambda r: r['intensity_displayed']['overstated_pct'])
    L.append('')
    L.append('Timing (backtest scorer; error = actual - predicted, min; + = late)')
    for k in ('start', 'end'):
        row(f'  {k} n', lambda r, k=k: r['timing'][k]['n'])
        row(f'  {k} MAE', lambda r, k=k: r['timing'][k]['mae'])
        row(f'  {k} bias', lambda r, k=k: r['timing'][k]['bias'])
    for m in METHODS:
        for k in ('start', 'end'):
            row(f'  {m} {k} MAE / bias / n',
                lambda r, m=m, k=k: '{}/{}/{}'.format(r['timing']['by_method'][m][k]['mae'],
                                                     r['timing']['by_method'][m][k]['bias'],
                                                     r['timing']['by_method'][m][k]['n']))
    L.append('')
    L.append('Label hygiene')
    row('  +10/+20/+30 identical %', lambda r: r['hygiene']['leads_10_20_30_identical_pct'])
    row('  ...identical when any wet %', lambda r: r['hygiene']['leads_10_20_30_identical_when_any_wet_pct'])
    row('  current lag median (min)', lambda r: r['hygiene']['current_lag_min']['median'])
    row('  current lag p90 (min)', lambda r: r['hygiene']['current_lag_min']['p90'])
    for src in ('mrms', 'asos', 'mesonet', 'none'):
        row(f'  current truth n [{src}]', lambda r, s=src: r['hygiene']['current_source_counts'].get(s, 0))
    for m in (10, 30, 60):
        for src in ('mrms', 'asos', 'none'):
            row(f'  +{m} truth n [{src}]',
                lambda r, m=m, s=src: r['hygiene']['lead_source_counts'][f'+{m}'].get(s, 0))
    L.append('')
    L.append('PER CITY  rainFA% / rain precision% / intensity correct% (n) / start MAE')
    all_cities = sorted({c for n in names for c in cities[n]})
    L.append(f'{"":14}' + ''.join(f'{n:>30}' for n in names))
    for c in all_cities:
        cells = []
        for n in names:
            d = cities[n].get(c)
            cells.append('-' if not d else
                         f'{d["rain_fa_pct"]}/{d["rain_precision_pct"]}/'
                         f'{d["intensity_correct_pct"]}({d["intensity_n"]})/{d["start_mae"]}')
        L.append(f'{c:14}' + ''.join(f'{x:>30}' for x in cells))
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runs', nargs='+', help='name=path/to/snapshots.csv')
    ap.add_argument('--out', help='write the text table here')
    ap.add_argument('--json', help='write the full result as JSON here')
    args = ap.parse_args()
    results, cities = {}, {}
    for spec in args.runs:
        name, path = spec.split('=', 1)
        df = load(path)
        results[name] = summarize(df)
        cities[name] = per_city(df)
    text = render(results, cities)
    sys.stdout.reconfigure(encoding='utf-8')
    print(text)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({'pooled': results, 'per_city': cities}, f, indent=1, default=str)


if __name__ == '__main__':
    main()
