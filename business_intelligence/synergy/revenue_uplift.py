"""
Synergy-adjusted revenue scenarios on top of the existing revenue engine.

  uplift(scenario) = cap(scenario) × (synergy score / 100) × (0.5 + 0.5 × data coverage)
  adjusted         = base × (1 + uplift)
  additional       = adjusted − base

The caps (5 / 10 / 15 % by default) are ILLUSTRATIVE assumptions, not measured effects:
there is no sales data to estimate them. Scaling by the score means little synergy gives
little uplift; scaling by coverage halves the claim where the map data is thin.
"""
from . import configuration as cfg

SCENARIO_ORDER = ('conservative', 'moderate', 'optimistic')


def scenarios(base_monthly, score, data_coverage):
    base = max(0.0, float(base_monthly or 0))
    factor = (max(0.0, min(100.0, score)) / 100.0) * (0.5 + 0.5 * max(0.0, min(1.0, data_coverage)))
    caps = cfg.uplift_caps()
    rows = [{'scenario': 'base', 'label': 'Base (revenue engine)', 'uplift_pct': 0.0,
             'monthly': round(base), 'additional': 0}]
    for name in SCENARIO_ORDER:
        uplift = caps[name] * factor
        adjusted = base * (1.0 + uplift)
        rows.append({'scenario': name, 'label': name.capitalize(), 'uplift_pct': round(uplift * 100, 2),
                     'cap_pct': round(caps[name] * 100, 1), 'monthly': round(adjusted), 'additional': round(adjusted - base)})
    return {
        'base_monthly': round(base),
        'rows': rows,
        'factor': round(factor, 4),
        'method': (f"Uplift = scenario cap × (synergy score ÷ 100) × (0.5 + 0.5 × data coverage). Caps: "
                   f"{', '.join(f'{n} {caps[n] * 100:g}%' for n in SCENARIO_ORDER)}. The caps are illustrative assumptions, "
                   "not measured results; base revenue comes from the platform's revenue engine."),
        'is_estimate': True,
    }
