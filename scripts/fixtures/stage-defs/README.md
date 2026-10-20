Fixtures: the 9 roster stage defs, fetched verbatim from
https://raw.githubusercontent.com/FightingGameEngine/Assets/main/stages/<id>.def
on 2026-10-20 (at the expanded-stage-view change).

They are the REAL inputs the vfs.js expanded fit (patchStageDefExpanded)
rewrites at engine boot in the expanded display mode — the unit harness
(scripts/verify-expanded-fit.mjs) runs the shipped patch function against
these files. Geometry note that drove the design: every fixture's painted
art spans ±(localcoordW/2 + |boundleft|) = ±836u (544+292, 640+196, 448+388)
— the roster generator matches the pan bounds to the art, which is what
makes the ±(artHalf - fitW/2) pan-bound rewrite safe.

Re-fetch (if the roster changes) with:
  curl -s -o <id>.def https://raw.githubusercontent.com/FightingGameEngine/Assets/main/stages/<id>.def
Stage ids come from the Assets repo manifest.json `stages[]` entries.
