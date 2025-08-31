# hexo-imagesize-intrinsic

A [Hexo](https://hexo.io/) plugin that writes **intrinsic `width`/`height` attributes** for remote `<img>` tags at build time.  
This reduces **Cumulative Layout Shift (CLS)** and improves visual stability.

## Example

**Before (raw post content):**

```html
<p>
  <img src="https://cdn.example.com/example.png" alt="Demo image">
</p>
```
The image has no intrinsic size.
When the browser loads, the layout may jump (CLS).

**After (generated HTML by Hexo):**

```html
<p>
  <img src="https://cdn.example.com/example.png" alt="Demo image" width="1280" height="720">
</p>
```
The plugin probed the remote image, detected its intrinsic size (1280x720),
and wrote width/height attributes into the `<img>`.

👉 Result: The page reserves space before the image is loaded, avoiding layout shift.

## Features

- ✅ Automatically detects remote images in posts/pages (`layout: post` or `page`)  
- ✅ Writes intrinsic `width` and `height` attributes into `<img>`  
- ✅ Supports **non-ASCII filenames** (Chinese, spaces, etc.)  
- ✅ Caches probed sizes in `.cache/hexo-imgsize.json`  
- ✅ Writes per-run report `.cache/imgsize-run-report.json` (grouped by page, with `url/status/reason`)  
- ✅ Configurable **concurrency**, **timeout**, **retry**, **headers**, **referer**  
- ✅ Optional **progress bar** (on stderr)  
- ✅ Three log levels: `off | summary | verbose`


## Install

```bash
npm install hexo-imagesize-intrinsic --save
```
Hexo will automatically load it.

## Configuration

### Minimal setup

In your site `_config.yml`, add:

```yml
imagesize_intrinsic:
  enabled: true
  log_level: summary   # off | summary | verbose
  progress: true       # show progress bar
```
This is usually enough for most sites.

### Advanced options
| Option                    | Default   | Description                                                                 |
|---------------------------|-----------|-----------------------------------------------------------------------------|
| `enabled`                 | `true`    | Master switch for the plugin                                                |
| `log_level`               | `summary` | `off` = no logs; `summary` = only totals; `verbose` = per page & per image  |
| `progress`                | `true`    | Show progress bar on **stderr**                                             |
| `concurrency`             | `8`       | Number of concurrent probes (increase for faster builds if network allows)  |
| `timeout_ms`              | `8000`    | Timeout for each probe in milliseconds                                      |
| `retry`                   | `1`       | Retry count after a failed probe                                            |
| `strip_query`             | `false`   | Drop `?query` part of URL when caching size (useful if query doesn’t change pixels) |
| `referer`                 | `""`      | Optional Referer header for anti-hotlinking hosts                           |
| `headers`                 | `{}`      | Extra request headers (merged with defaults)                                |
| `whitelist`               | `[]`      | List of hostnames to process; empty = all remote images                     |
| `cache_present_with_size` | `true`    | Cache images that already have width/height, so other pages can reuse       |

## Output

- **Cache file**:
    `.cache/hexo-imgsize.json`
    Stores probed sizes for reuse across builds.
- **Run report**:
    `.cache/imgsize-run-report.json`
    Example:
    ```json
    {
    "pages": [
        {
        "page": "posts/hello-world.md",
        "images": [
            {"url":"https://cdn.example.com/a.png","status":"wrote"},
            {"url":"https://cdn.example.com/b.png","status":"cached"},
            {"url":"https://cdn.example.com/c.png","status":"failed","reason":"timeout"},
            {"url":"https://cdn.example.com/d.png","status":"skipped","reason":"already-has-size"}
        ]
        }
    ]
    }
    ```

- **Logs**:
    - summary → only final two lines:
      ```log
      [imgsize] [total] pages=23 imgs=157 wrote=100 cached=50 failed=5 skipped=2
      [imgsize] run report -> .cache/imgsize-run-report.json
      ```
	- verbose → per-page + per-image detail.

## Notes

- If your site already has a large number of images, the **first run may take a long time** because all image sizes need to be probed. Subsequent runs will be **much faster** thanks to the cache in `.cache/hexo-imgsize.json`.
- Works only for **remote images** (`http/https`). Local `source/` images are skipped.  
- Progress bar prints to **stderr**; Hexo’s `INFO` logs remain in stdout.  
- If you had a **theme script** doing similar work, remove it to avoid duplication.  
- You can increase `concurrency` (e.g. 12–16) to speed up builds, depending on your network and image host.  
- `timeout_ms` and `retry` can be tuned for stability.  

## License

MIT © Keldos Li