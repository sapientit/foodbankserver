---
paths:
  - 'src/core/time/**'
  - 'src/core/clock.ts'
  - 'src/modules/**/*.service.ts'
---

# Time rules

- **`Europe/London` is the only local timezone.** Templates and sessions store the wall clock the
  charity typed (`YYYY-MM-DD` + `HH:MM`) **plus** a derived UTC instant that queries sort and filter
  on. A 10:00 session stays 10:00 across the BST changeover; getting the direction backwards
  silently moves every session by an hour for half the year.
- Conversion lives in `core/time/london.ts`, calendar arithmetic in `core/time/plain-date.ts`. Both
  are pure. **Do not do date maths anywhere else, and do not add a date library** — Workers ships
  full ICU, so `Intl` covers it.
- **Services never call `new Date()` or `Date.now()`** — they take a `Clock` from `core/clock.ts`.
  Fake timers do not work in the Workers test runner, so this is the only way expiry is testable.
- **Workers gotcha: `Date.now()` does not advance during a request** until I/O occurs. Two
  consecutive calls return the same value. Never write code that measures elapsed time in a handler.
- Date fixtures in tests should straddle a BST/GMT boundary where the behaviour could hide an error
  — a London date that differs from the UTC date is the case that catches it.
