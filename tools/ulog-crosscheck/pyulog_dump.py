"""Reads a ULog file with pyulog (PX4's reference Python implementation) and dumps everything
the Athena-sky parser extracts (topics, logged messages, parameters, info, dropouts) as JSON.
With --rewrite it also writes the log back out with pyulog's own ULog writer.

Usage: python3 pyulog_dump.py <in.ulg> <out.json> [--rewrite <out.ulg>]
Requires: pip install pyulog
"""
import argparse
import json
import math

from pyulog import ULog


def num(v):
    f = float(v)
    return None if math.isnan(f) else f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ulog')
    ap.add_argument('out_json')
    ap.add_argument('--rewrite')
    a = ap.parse_args()

    u = ULog(a.ulog)
    topics = []
    for d in u.data_list:
        topics.append({
            'name': d.name,
            'multiId': d.multi_id,
            'fields': {k: [num(x) for x in v] for k, v in d.data.items()},
        })
    out = {
        'pyulogStartTimestamp': u.start_timestamp,
        'info': {k: (v if isinstance(v, (int, float, str)) else str(v)) for k, v in u.msg_info_dict.items()},
        'params': {k: num(v) for k, v in u.initial_parameters.items()},
        'messages': [{'t': m.timestamp, 'level': m.log_level, 'text': m.message} for m in u.logged_messages],
        'dropouts': [{'t': d.timestamp, 'durationMs': d.duration} for d in u.dropouts],
        'topics': topics,
    }
    with open(a.out_json, 'w') as f:
        json.dump(out, f)
    if a.rewrite:
        u.write_ulog(a.rewrite)


if __name__ == '__main__':
    main()
