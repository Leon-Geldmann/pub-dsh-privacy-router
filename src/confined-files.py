"""Bounded one-request POSIX filesystem helper, launched with Python -I -S."""
import base64
import errno
import json
import os
import secrets
import stat
import sys

MAX_FILE = 2 * 1024 * 1024
MAX_REQUEST = 3 * 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
MAX_ENTRIES = 30000
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def validate(root, relative, directory=False):
    if (not isinstance(root, str) or not root.startswith('/') or root == '/'
            or '\x00' in root or any(p in ('', '.', '..') for p in root[1:].split('/'))):
        raise ValueError('Unsafe filesystem root')
    if directory and relative == '':
        return
    if (not isinstance(relative, str) or not relative
            or any(c in relative for c in '\\*?[]{}')
            or any(ord(c) < 32 for c in relative)
            or any(p in ('', '.', '..') for p in relative.split('/'))):
        raise ValueError('Unsafe relative path')


def directory_fd(root, relative='', create=False):
    fd = os.open('/', DIRECTORY)
    try:
        root_parts = root[1:].split('/')
        parts = root_parts + (relative.split('/') if relative else [])
        for index, part in enumerate(parts):
            if create and index >= len(root_parts):
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def safe_file(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Unsafe file')
    if info.st_size > MAX_FILE:
        raise ValueError('Oversized file')


def destination(fd, name):
    try:
        safe_file(os.stat(name, dir_fd=fd, follow_symlinks=False))
    except FileNotFoundError:
        pass


def operate(request):
    operation = request.get('operation')
    root, relative = request.get('root'), request.get('relative')
    validate(root, relative, operation == 'entries')
    if operation == 'entries':
        fd = directory_fd(root, relative)
        try:
            entries, size = [], 0
            with os.scandir(fd) as iterator:
                for entry in iterator:
                    kind = 'directory' if entry.is_dir(follow_symlinks=False) else 'file' if entry.is_file(follow_symlinks=False) else 'other'
                    item = {'name': entry.name, 'type': kind}
                    size += len(json.dumps(item, ensure_ascii=True)) + 1
                    if len(entries) >= MAX_ENTRIES or size > MAX_RESPONSE - 1024:
                        raise ValueError('Workspace entry limit exceeded')
                    entries.append(item)
            return entries
        finally:
            os.close(fd)
    if operation not in ('read', 'write', 'remove'):
        raise ValueError('Unsafe filesystem operation')
    data, mode = None, request.get('mode', 0o600)
    if operation == 'write':
        if not isinstance(mode, int) or isinstance(mode, bool) or not 0 <= mode <= 0o777:
            raise ValueError('Unsafe file mode')
        data = base64.b64decode(request.get('data', ''), validate=True)
        if len(data) > MAX_FILE:
            raise ValueError('Oversized file')
    parent, _, name = relative.rpartition('/')
    fd = directory_fd(root, parent, operation == 'write')
    try:
        if operation == 'read':
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
            try:
                info = os.fstat(file_fd)
                safe_file(info)
                chunks, length = [], 0
                while length <= MAX_FILE:
                    chunk = os.read(file_fd, min(65536, MAX_FILE + 1 - length))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    length += len(chunk)
                safe_file(os.fstat(file_fd))
                if length > MAX_FILE:
                    raise ValueError('Oversized file')
                return {'data': base64.b64encode(b''.join(chunks)).decode('ascii'), 'mode': info.st_mode & 0o777}
            finally:
                os.close(file_fd)
        if operation == 'remove':
            safe_file(os.stat(name, dir_fd=fd, follow_symlinks=False))
            os.unlink(name, dir_fd=fd)
            return None
        destination(fd, name)
        temporary = '.privacy-' + secrets.token_hex(16)
        created = False
        try:
            file_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=fd)
            created = True
            try:
                remaining = memoryview(data)
                while remaining:
                    count = os.write(file_fd, remaining)
                    if count <= 0:
                        raise OSError(errno.EIO, 'File write made no progress')
                    remaining = remaining[count:]
            finally:
                os.close(file_fd)
            destination(fd, name)
            os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        finally:
            if created:
                try:
                    os.unlink(temporary, dir_fd=fd)
                except FileNotFoundError:
                    pass
        return None
    finally:
        os.close(fd)


def main():
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if len(data) > MAX_REQUEST:
            raise ValueError('Filesystem request limit exceeded')
        request = json.loads(data)
        if not isinstance(request, dict):
            raise ValueError('Invalid filesystem request')
        response = {'ok': True, 'result': operate(request)}
    except Exception as error:
        response = {'ok': False, 'error': str(error)[:2048], 'code': errno.errorcode.get(error.errno) if isinstance(error, OSError) else None}
    encoded = json.dumps(response, ensure_ascii=True).encode('ascii')
    if len(encoded) > MAX_RESPONSE:
        encoded = b'{"ok":false,"error":"Filesystem response limit exceeded"}'
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    main()
