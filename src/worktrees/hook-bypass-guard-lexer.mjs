// worktree-guard/hook-bypass-guard-lexer.mjs
//
// Shell lexer for hook-bypass-guard.mjs. Pure text -> structure; no I/O. Node built-ins only.

const RESERVED_PREFIX = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done', 'esac']);

// ───────────────────────────── lexer ─────────────────────────────

/**
 * Lex a shell script into { commands: [{ words:[{text,dyn}], stdinTexts:[string] }], nested:[string], ambiguous }.
 * `nested` holds sub-scripts (command substitutions, process substitutions) analysed recursively.
 */
export function lexShell(text) {
  const commands = [];
  const nested = [];
  const heredocBodies = [];
  const pendingHeredocs = []; // { delim, strip, command }
  let ambiguous = false;
  let cur = { words: [], stdinTexts: [] };
  let word = null; // { text, dyn }
  let afterRedirect = null; // 'drop' → next word is a redirect target

  const pushWord = () => {
    if (word === null) return;
    const w = word;
    word = null;
    if (afterRedirect) {
      afterRedirect = null;
      return;
    }
    if (cur.words.length === 0 && RESERVED_PREFIX.has(w.text) && !w.quoted) return;
    // Redirect operators glued to nothing (`>`, `2>`, `>>`, `<`, `&>`) swallow the next word.
    if (/^\d*(>>?|<|>\||&>>?|>&|<&)$/.test(w.text) && !w.quoted) {
      afterRedirect = 'drop';
      return;
    }
    // Redirect with attached target (`>file`, `2>&1`, `<in`): not an argv word.
    if (/^\d*(>>?|<|>\||&>>?|>&|<&)[^<>]/.test(w.text) && !w.quoted) return;
    cur.words.push(w);
  };
  const endCommand = () => {
    pushWord();
    afterRedirect = null;
    if (cur.words.length > 0 || cur.stdinTexts.length > 0) commands.push(cur);
    cur = { words: [], stdinTexts: [] };
  };

  const n = text.length;
  let i = 0;

  // Reads a balanced `( … )` starting after the opening paren; returns inner text or null (unbalanced).
  const readBalancedParen = (start) => {
    let depth = 1;
    let j = start;
    let q = null;
    while (j < n) {
      const c = text[j];
      if (q === "'") {
        if (c === "'") q = null;
      } else if (q === '"') {
        if (c === '\\') j++;
        else if (c === '"') q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') j++;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return { inner: text.slice(start, j), end: j + 1 };
      }
      j++;
    }
    return null;
  };
  const readBacktick = (start) => {
    let j = start;
    while (j < n) {
      if (text[j] === '\\') j += 2;
      else if (text[j] === '`') return { inner: text.slice(start, j).replace(/\\`/g, '`'), end: j + 1 };
      else j++;
    }
    return null;
  };
  const addText = (s, dyn = false) => {
    if (word === null) word = { text: '', dyn: false, quoted: false };
    word.text += s;
    if (dyn) word.dyn = true;
  };
  const readHeredocBodies = () => {
    // `i` sits right after a newline; consume bodies for every pending heredoc, in order.
    while (pendingHeredocs.length > 0) {
      const h = pendingHeredocs.shift();
      const lines = [];
      let found = false;
      while (i <= n) {
        if (i >= n) break;
        let eol = text.indexOf('\n', i);
        if (eol < 0) eol = n;
        let line = text.slice(i, eol);
        i = Math.min(eol + 1, n + 1);
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) {
          found = true;
          break;
        }
        lines.push(line);
      }
      if (!found && i > n) ambiguous = ambiguous || false;
      const body = lines.join('\n');
      h.command.stdinTexts.push(body);
      heredocBodies.push(body);
    }
  };

  while (i < n) {
    const c = text[i];

    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 >= n) {
        i++;
        continue;
      }
      addText(text[i + 1]);
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) {
        ambiguous = true;
        addText(text.slice(i + 1));
        i = n;
        break;
      }
      addText(text.slice(i + 1, close));
      if (word) word.quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === "'") {
      let j = i + 2;
      let out = '';
      let closed = false;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) {
          out += text[j + 1];
          j += 2;
        } else if (text[j] === "'") {
          closed = true;
          break;
        } else out += text[j++];
      }
      if (!closed) ambiguous = true;
      addText(out);
      if (word) word.quoted = true;
      i = closed ? j + 1 : n;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      if (word === null) word = { text: '', dyn: false, quoted: false };
      word.quoted = true;
      while (j < n) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) {
          const e = text[j + 1];
          if (e === '\n') {
            j += 2;
            continue;
          }
          addText('"\\$`'.includes(e) ? e : '\\' + e);
          j += 2;
        } else if (d === '"') {
          closed = true;
          j++;
          break;
        } else if (d === '$' && text[j + 1] === '(') {
          const r = readBalancedParen(j + 2);
          if (!r) {
            ambiguous = true;
            j = n;
            break;
          }
          nested.push(r.inner);
          addText('$(…)', true);
          j = r.end;
        } else if (d === '`') {
          const r = readBacktick(j + 1);
          if (!r) {
            ambiguous = true;
            j = n;
            break;
          }
          nested.push(r.inner);
          addText('`…`', true);
          j = r.end;
        } else if (d === '$') {
          const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(j));
          if (m) {
            addText(m[0], true);
            j += m[0].length;
          } else addText(d), j++;
        } else {
          addText(d);
          j++;
        }
      }
      if (!closed) ambiguous = true;
      i = j;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const r = readBalancedParen(i + 2);
      if (!r) {
        ambiguous = true;
        addText(text.slice(i), true);
        i = n;
        break;
      }
      nested.push(r.inner);
      addText('$(…)', true);
      i = r.end;
      continue;
    }
    if (c === '`') {
      const r = readBacktick(i + 1);
      if (!r) {
        ambiguous = true;
        addText(text.slice(i), true);
        i = n;
        break;
      }
      nested.push(r.inner);
      addText('`…`', true);
      i = r.end;
      continue;
    }
    if (c === '$') {
      const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i));
      if (m) {
        addText(m[0], true);
        i += m[0].length;
      } else {
        addText('$');
        i++;
      }
      continue;
    }
    if ((c === '<' || c === '>') && text[i + 1] === '(') {
      const r = readBalancedParen(i + 2);
      if (!r) {
        ambiguous = true;
        i = n;
        break;
      }
      nested.push(r.inner);
      i = r.end;
      continue;
    }
    if (c === '#' && word === null) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCommand();
      i++;
      if (pendingHeredocs.length > 0) readHeredocBodies();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i++;
      continue;
    }
    if (c === ';' || c === '(' || c === ')') {
      endCommand();
      i++;
      continue;
    }
    if (c === '&' && text[i + 1] === '&') {
      endCommand();
      i += 2;
      continue;
    }
    if (c === '|') {
      endCommand();
      i += text[i + 1] === '|' || text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      // `&>` / `&>>` is a redirect (glued to the word); a lone `&` backgrounds and separates commands.
      if (text[i + 1] === '>') {
        pushWord();
        word = { text: '&>', dyn: false, quoted: false };
        i += 2;
        if (text[i] === '>') i++;
        pushWord();
        continue;
      }
      endCommand();
      i++;
      continue;
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      // here-string: the next word is stdin text for this command.
      pushWord();
      i += 3;
      while (text[i] === ' ' || text[i] === '\t') i++;
      const save = { word, afterRedirect };
      word = null;
      afterRedirect = null;
      // lex a single word by reusing the main loop is awkward; scan it with a mini-reader.
      let buf = '';
      let q = null;
      while (i < n) {
        const d = text[i];
        if (q) {
          if (d === q) q = null;
          else if (q === '"' && d === '\\' && i + 1 < n) buf += text[++i];
          else buf += d;
          i++;
          continue;
        }
        if (d === "'" || d === '"') {
          q = d;
          i++;
          continue;
        }
        if (/\s|[;&|()]/.test(d)) break;
        buf += d;
        i++;
      }
      cur.stdinTexts.push(buf);
      word = save.word;
      afterRedirect = save.afterRedirect;
      continue;
    }
    if (c === '<' && text[i + 1] === '<') {
      pushWord();
      let j = i + 2;
      let strip = false;
      if (text[j] === '-') {
        strip = true;
        j++;
      }
      while (text[j] === ' ' || text[j] === '\t') j++;
      let delim = '';
      let q = null;
      while (j < n) {
        const d = text[j];
        if (q) {
          if (d === q) q = null;
          else delim += d;
          j++;
          continue;
        }
        if (d === "'" || d === '"') {
          q = d;
          j++;
          continue;
        }
        if (d === '\\' && j + 1 < n) {
          delim += text[j + 1];
          j += 2;
          continue;
        }
        if (/\s|[;&|()<>]/.test(d)) break;
        delim += d;
        j++;
      }
      pendingHeredocs.push({ delim, strip, command: cur });
      i = j;
      continue;
    }
    addText(c);
    i++;
  }
  if (pendingHeredocs.length > 0) {
    // heredoc with no terminating newline: nothing to read.
    pendingHeredocs.length = 0;
  }
  endCommand();
  return { commands, nested, heredocBodies, ambiguous };
}
