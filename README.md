# chaturbetter-tag-merge

Tampermonkey script for [Chaturbetter](https://chaturbetter.com/). The site tag search is AND-only (`?tags=`). This adds a **Query** switch right after `.filter-search-toggle` so you can type `AND` / `OR` instead of clicking tag buttons.

Each OR branch is fetched as its own tags page and the room cards are merged.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste [`chaturbetter-tag-merge-text-scheme.user.js`](./chaturbetter-tag-merge-text-scheme.user.js).
3. Open Chaturbetter. Turn on **Query** next to Search, type a scheme, press Go.

## Scheme

```
bigboobs AND (findom OR sph)
blonde | redhead
#blonde or #redhead -asian
```

| You write | Fetches |
|---|---|
| `a AND b` or `a & b` | one page, `?tags=a,b` |
| `a OR b` or `a \| b` | `?tags=a` and `?tags=b`, cards merged |
| `a AND (b OR c)` | `?tags=a,b` and `?tags=a,c` |
| `-tag` | that tag is excluded (`extags`) |

`#` before a tag is optional. Parentheses group. Words next to each other are AND. Gender and sort already in the URL are kept on every fetch.

Optional saved rules live in the `SCHEME` block at the top of the script. A line runs when the current tags are exactly one branch, then the other branches are fetched. `WHERE key=value` requires that query param (`f=yes` is the female filter).
