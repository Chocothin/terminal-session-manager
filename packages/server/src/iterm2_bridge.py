#!/usr/bin/env python3
"""
iTerm2 Python API Bridge — Long-running asyncio process that communicates
with the Node.js server via NDJSON over stdio.

Protocol (stdin → Python):
  {"type":"list"}
  {"type":"attach","sessionId":"...","cols":120,"rows":40}
  {"type":"detach"}
  {"type":"input","data":"..."}
  {"type":"resize","cols":130,"rows":45}
  {"type":"getHistory","lines":100}
  {"type":"ping"}

Protocol (Python → stdout):
  {"type":"ready","sessions":[...]}
  {"type":"screen","sessionId":"...","ansi":"<raw ANSI>"}
  {"type":"sessions","sessions":[...]}
  {"type":"history","lines":[...],"hasMore":bool,"overflow":int}
  {"type":"pong"}
  {"type":"error","message":"..."}
  {"type":"detached"}
"""

import asyncio
import json
import sys
import re
import unicodedata


# ─── ANSI Serializer ──────────────────────────────────────────────────────────

def _is_wide(ch: str) -> bool:
    """Check if a character takes 2 cells (CJK, emoji, etc.)."""
    if len(ch) != 1:
        return False
    ea = unicodedata.east_asian_width(ch)
    return ea in ('W', 'F')


def _build_sgr(style, is_fg: bool = True) -> str:
    """Build SGR sequence for a color object."""
    color = style.fg_color if is_fg else style.bg_color
    prefix = '38' if is_fg else '48'

    if color is None:
        return f'\x1b[{"39" if is_fg else "49"}m'

    if color.is_rgb:
        rgb = color.rgb
        return f'\x1b[{prefix};2;{rgb.red};{rgb.green};{rgb.blue}m'
    elif color.is_standard:
        idx = color.standard
        if idx < 8:
            return f'\x1b[{30 + idx if is_fg else 40 + idx}m'
        elif idx < 16:
            return f'\x1b[{90 + idx - 8 if is_fg else 100 + idx - 8}m'
        else:
            return f'\x1b[{prefix};5;{idx}m'
    else:
            return f'\x1b[{"39" if is_fg else "49"}m'


def _style_to_sgr(style) -> str:
    """Convert a CellStyle to a full SGR escape sequence."""
    parts: list[str] = ['\x1b[0m']

    attrs: list[str] = []
    if style.bold:
        attrs.append('1')
    if style.faint:
        attrs.append('2')
    if style.italic:
        attrs.append('3')
    if style.underline:
        attrs.append('4')
    if style.blink:
        attrs.append('5')
    if style.inverse:
        attrs.append('7')
    if style.invisible:
        attrs.append('8')
    if style.strikethrough:
        attrs.append('9')

    if attrs:
        parts.append(f'\x1b[{";".join(attrs)}m')

    parts.append(_build_sgr(style, is_fg=True))
    parts.append(_build_sgr(style, is_fg=False))

    return ''.join(parts)


def _style_key(style) -> tuple:
    """Create a hashable key from a style for comparison."""
    if style is None:
        return ('none',)

    fg_key: tuple
    fg = style.fg_color
    if fg is None:
        fg_key = ('default',)
    elif fg.is_rgb:
        rgb = fg.rgb
        fg_key = ('rgb', rgb.red, rgb.green, rgb.blue)
    elif fg.is_standard:
        fg_key = ('std', fg.standard)
    else:
        fg_key = ('alt',)

    bg_key: tuple
    bg = style.bg_color
    if bg is None:
        bg_key = ('default',)
    elif bg.is_rgb:
        rgb = bg.rgb
        bg_key = ('rgb', rgb.red, rgb.green, rgb.blue)
    elif bg.is_standard:
        bg_key = ('std', bg.standard)
    else:
        bg_key = ('alt',)

    return (
        fg_key, bg_key,
        style.bold, style.italic, style.underline,
        style.faint, style.blink, style.inverse,
        style.invisible, style.strikethrough,
    )


def serialize_screen(contents, cols: int, rows: int) -> str:
    """
    Convert iTerm2 ScreenContents into raw ANSI escape sequences that
    xterm.js can render directly. Full redraw each time.
    """
    buf: list[str] = ['\x1b[?25l', '\x1b[H']

    prev_key: tuple | None = None

    for row_idx in range(rows):
        line = contents.line(row_idx)
        line_str = line.string
        col = 0

        while col < cols:
            if col < len(line_str):
                style = line.style_at(col)
                sk = _style_key(style)

                if sk != prev_key and style is not None:
                    buf.append(_style_to_sgr(style))
                    prev_key = sk

                char_at = line.string_at(col)
                if char_at:
                    buf.append(char_at)
                    if _is_wide(char_at):
                        col += 2
                        continue
                else:
                    buf.append(' ')
            else:
                if prev_key != ('none',):
                    buf.append('\x1b[0m')
                    prev_key = ('none',)
                buf.append(' ')

            col += 1

        if row_idx < rows - 1:
            buf.append('\r\n')

    buf.append('\x1b[0m')

    cursor = contents.cursor_coord
    buf.append(f'\x1b[{cursor.y + 1};{cursor.x + 1}H')
    buf.append('\x1b[?25h')

    result = ''.join(buf)
    result = result.replace('\x1b[6n', '')

    return result


# ─── NDJSON I/O ────────────────────────────────────────────────────────────────

def emit(data: dict) -> None:
    """Write NDJSON line to stdout."""
    line = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    sys.stdout.write(line + '\n')
    sys.stdout.flush()


def emit_error(message: str) -> None:
    emit({'type': 'error', 'message': message})


# ─── Session Info Serializer ────────────────────────────────────────────────

async def session_to_dict(session) -> dict:
    """Serialize an iTerm2 Session to a JSON-friendly dict."""
    try:
        tty = await session.async_get_variable('tty') or ''
    except Exception:
        tty = ''

    return {
        'id': session.session_id,
        'name': session.name or 'Untitled',
        'tty': tty,
        'cols': session.grid_size.width,
        'rows': session.grid_size.height,
    }


async def list_all_sessions(app) -> list[dict]:
    """Enumerate all sessions across all windows/tabs."""
    sessions: list[dict] = []
    for window in app.terminal_windows:
        for tab in window.tabs:
            for session in tab.sessions:
                sessions.append(await session_to_dict(session))
    return sessions


# ─── Bridge Controller ─────────────────────────────────────────────────────────

class BridgeController:
    def __init__(self, connection, app):
        self.connection = connection
        self.app = app
        self.attached_session = None
        self.stream_task: asyncio.Task | None = None
        self.attached_session_id: str | None = None

    async def handle_list(self) -> None:
        sessions = await list_all_sessions(self.app)
        emit({'type': 'sessions', 'sessions': sessions})

    async def handle_attach(self, session_id: str, cols: int, rows: int) -> None:
        await self.handle_detach(silent=True)

        session = self.app.get_session_by_id(session_id)
        if session is None:
            emit_error(f'Session not found: {session_id}')
            return

        self.attached_session = session
        self.attached_session_id = session_id

        await self._emit_screen_snapshot(session)
        self.stream_task = asyncio.create_task(self._stream_screen(session))

    async def _emit_screen_snapshot(self, session) -> None:
        """Send a one-shot ANSI snapshot of the current screen."""
        try:
            contents = await session.async_get_screen_contents()
            cols = session.grid_size.width
            rows = session.grid_size.height
            ansi = serialize_screen(contents, cols, rows)
            emit({
                'type': 'screen',
                'sessionId': session.session_id,
                'ansi': ansi,
                'cols': cols,
                'rows': rows,
            })
        except Exception as e:
            emit_error(f'Screen snapshot error: {e}')

    async def _stream_screen(self, session) -> None:
        try:
            async with session.get_screen_streamer() as streamer:
                while True:
                    contents = await streamer.async_get(style=True)
                    if contents is None:
                        continue

                    cols = session.grid_size.width
                    rows = session.grid_size.height

                    try:
                        ansi = serialize_screen(contents, cols, rows)
                    except Exception:
                        continue

                    emit({
                        'type': 'screen',
                        'sessionId': session.session_id,
                        'ansi': ansi,
                        'cols': cols,
                        'rows': rows,
                    })
        except asyncio.CancelledError:
            pass
        except Exception as e:
            emit_error(f'Screen stream error: {e}')

    async def handle_detach(self, silent: bool = False) -> None:
        if self.stream_task and not self.stream_task.done():
            self.stream_task.cancel()
            try:
                await self.stream_task
            except asyncio.CancelledError:
                pass
        self.stream_task = None
        self.attached_session = None
        self.attached_session_id = None
        if not silent:
            emit({'type': 'detached'})

    async def handle_input(self, data: str) -> None:
        if self.attached_session is None:
            emit_error('No session attached')
            return
        try:
            await self.attached_session.async_send_text(data)
        except Exception as e:
            emit_error(f'Input error: {e}')

    async def handle_resize(self, cols: int, rows: int) -> None:
        pass

    async def handle_ping(self) -> None:
        emit({'type': 'pong'})

    async def handle_get_history(self, num_lines: int) -> None:
        if self.attached_session is None:
            emit_error('No session attached')
            return

        try:
            line_info = await self.attached_session.async_get_line_info()

            overflow = line_info.overflow
            scrollback_height = line_info.scrollback_buffer_height

            screen_height = line_info.mutable_area_height
            total_height = scrollback_height + screen_height

            if num_lines <= 0:
                fetch_count = scrollback_height
            else:
                fetch_count = min(num_lines, scrollback_height)

            if fetch_count <= 0:
                emit({'type': 'history', 'lines': [], 'hasMore': False, 'overflow': overflow})
                return

            lines = await self.attached_session.async_get_contents(overflow, fetch_count)
            text_lines = [line.string.rstrip() for line in lines]

            emit({
                'type': 'history',
                'lines': text_lines,
                'hasMore': False,
                'overflow': overflow,
            })
        except Exception as e:
            emit_error(f'History fetch error: {e}')


# ─── Stdin Reader ────────────────────────────────────────────────────────────

async def read_stdin(controller: BridgeController) -> None:
    """Read NDJSON commands from stdin."""
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        try:
            line = await reader.readline()
            if not line:
                break

            line_str = line.decode('utf-8').strip()
            if not line_str:
                continue

            msg = json.loads(line_str)
            msg_type = msg.get('type', '')

            if msg_type == 'list':
                await controller.handle_list()
            elif msg_type == 'attach':
                await controller.handle_attach(
                    msg['sessionId'],
                    msg.get('cols', 80),
                    msg.get('rows', 24),
                )
            elif msg_type == 'detach':
                await controller.handle_detach()
            elif msg_type == 'input':
                await controller.handle_input(msg['data'])
            elif msg_type == 'resize':
                await controller.handle_resize(msg['cols'], msg['rows'])
            elif msg_type == 'ping':
                await controller.handle_ping()
            elif msg_type == 'getHistory':
                await controller.handle_get_history(msg.get('lines', 100))
            else:
                emit_error(f'Unknown message type: {msg_type}')

        except json.JSONDecodeError as e:
            emit_error(f'Invalid JSON: {e}')
        except Exception as e:
            emit_error(f'Stdin handler error: {e}')


# ─── Main ──────────────────────────────────────────────────────────────────────

async def main(connection) -> None:
    import iterm2
    app = await iterm2.async_get_app(connection)

    controller = BridgeController(connection, app)

    sessions = await list_all_sessions(app)
    emit({'type': 'ready', 'sessions': sessions})

    await read_stdin(controller)


if __name__ == '__main__':
    import iterm2
    iterm2.run_forever(main)
