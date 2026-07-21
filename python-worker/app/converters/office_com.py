"""Conversión de documentos Office a PDF vía COM (Word/Excel/PowerPoint).

Módulo independiente del flujo job/poller a propósito: la futura fase batch
(carpeta vigilada) lo importará tal cual.

Seguridad y robustez:
  - `AutomationSecurity = 3` fuerza las macros DESHABILITADAS: los documentos
    subidos son entrada no confiable.
  - Se abre `ReadOnly` y (Word/Excel) con una contraseña falsa, para que un
    documento protegido falle al instante en vez de colgar un diálogo invisible.
  - Watchdog: Office no tiene timeout propio y un documento patológico puede
    colgar la aplicación; como el poller es secuencial, un cuelgue pararía TODOS
    los jobs. El watchdog mata el proceso de Office (solo el NUESTRO: se rastrea
    el PID nuevo por diff antes/después de crear la instancia) y la llamada COM
    bloqueada despierta con com_error.
  - El `finally` remata los PIDs propios que sigan vivos: sin zombis aunque
    `Quit()` falle.

pywin32 se importa con guarda: en el contenedor Linux de docker-compose no
existe y el resto del worker debe seguir funcionando. Se usa dispatch dinámico
(sin makepy/gen_py) para que el exe de PyInstaller no dependa de cachés
generados; por eso las llamadas COM usan argumentos POSICIONALES (el dispatch
dinámico resuelve mal algunos nombres de parámetro).
"""
import os
import threading
import time
from pathlib import Path

try:  # pywin32 solo existe en Windows; ver docstring.
    import pythoncom
    import win32api
    import win32com.client
    import win32con
    import win32process
    COM_AVAILABLE = True
except ImportError:  # pragma: no cover - rama de Linux/containers
    COM_AVAILABLE = False

CONVERT_TIMEOUT_S = 180

# Constantes de las APIs de Office (dispatch dinámico: no hay win32com.client.constants)
WD_FORMAT_PDF = 17          # WdSaveFormat.wdFormatPDF
XL_TYPE_PDF = 0             # XlFixedFormatType.xlTypePDF
PP_SAVEAS_PDF = 32          # PpSaveAsFileType.ppSaveAsPDF
MSO_SECURITY_FORCE_DISABLE = 3  # msoAutomationSecurityForceDisable

WORD_EXE = 'WINWORD.EXE'
EXCEL_EXE = 'EXCEL.EXE'
PPT_EXE = 'POWERPNT.EXE'

# Contraseña falsa: un documento protegido falla al abrir (5408/"password
# incorrecta") en vez de mostrar un diálogo que nadie puede cerrar.
# MÁXIMO 15 caracteres: es el límite de contraseña de Word/Excel, y Word 2010
# VALIDA la longitud aunque el documento no esté protegido — con una más larga
# todo Open falla con "Command failed" (Word 2016 la tolera; cazado en QA).
_FAKE_PASSWORD = '#!invalid!#'


def _require_com() -> None:
    if not COM_AVAILABLE:
        raise ValueError('Office conversion is not available on this host (pywin32 missing)')


def _office_pids(exe_name: str) -> set:
    """PIDs de los procesos cuyo ejecutable es `exe_name` (p. ej. WINWORD.EXE)."""
    pids = set()
    for pid in win32process.EnumProcesses():
        try:
            handle = win32api.OpenProcess(
                win32con.PROCESS_QUERY_INFORMATION | win32con.PROCESS_VM_READ, False, pid)
        except win32api.error:
            continue  # proceso ajeno/protegido: no es Office nuestro
        try:
            name = os.path.basename(win32process.GetModuleFileNameEx(handle, 0))
            if name.upper() == exe_name.upper():
                pids.add(pid)
        except win32api.error:
            pass
        finally:
            handle.Close()
    return pids


def _kill_pids(pids: set) -> None:
    """Termina los procesos indicados (best-effort)."""
    for pid in pids:
        try:
            handle = win32api.OpenProcess(win32con.PROCESS_TERMINATE, False, pid)
        except win32api.error:
            continue  # ya murió o no es nuestro
        try:
            win32api.TerminateProcess(handle, 1)
        except win32api.error:
            pass
        finally:
            handle.Close()


class _Watchdog:
    """Mata los PIDs de Office rastreados si la conversión excede el timeout."""

    def __init__(self, exe_name: str, before: set):
        self.exe_name = exe_name
        self.before = before
        self.timed_out = threading.Event()
        self._timer = threading.Timer(CONVERT_TIMEOUT_S, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def _fire(self) -> None:
        self.timed_out.set()
        _kill_pids(_office_pids(self.exe_name) - self.before)

    def cancel(self) -> None:
        self._timer.cancel()

    def cleanup(self) -> None:
        """Remata cualquier instancia nuestra que siga viva (post-Quit)."""
        self.cancel()
        # Pequeño margen: Quit() es asíncrono y el proceso tarda en salir solo.
        for _ in range(10):
            leftover = _office_pids(self.exe_name) - self.before
            if not leftover:
                return
            time.sleep(0.3)
        _kill_pids(_office_pids(self.exe_name) - self.before)


def _com_error_message(app_name: str, exc: Exception, watchdog: '_Watchdog') -> str:
    if watchdog.timed_out.is_set():
        return f'{app_name} conversion timed out after {CONVERT_TIMEOUT_S}s'
    detail = _com_error_detail(exc)
    if 'password' in detail.lower() or 'contraseña' in detail.lower():
        return 'The document is password-protected'
    # Incluir el detalle: el mensaje llega a error_message del job y sin él es
    # imposible diagnosticar (versiones de Office distintas fallan distinto).
    return f'{app_name} could not convert the document: {detail[:300]}'


def _com_error_detail(exc: Exception) -> str:
    """Texto humano del com_error: la descripción de excepinfo si existe."""
    excepinfo = getattr(exc, 'excepinfo', None)
    if excepinfo and len(excepinfo) > 2 and excepinfo[2]:
        return str(excepinfo[2]).strip()
    return str(exc)


def convert_word(input_path: Path, output_path: Path) -> None:
    """Word/RTF/ODT/TXT → PDF con Word COM."""
    _require_com()
    pythoncom.CoInitialize()
    before = _office_pids(WORD_EXE)
    watchdog = _Watchdog(WORD_EXE, before)
    app = None
    own_instance = False
    try:
        app = win32com.client.DispatchEx('Word.Application')
        # DispatchEx puede COMPARTIR una instancia ya abierta (observado con
        # Word): solo se hace Quit si apareció un proceso nuevo, para no cerrar
        # el Word de un usuario interactivo en una máquina de desarrollo.
        own_instance = bool(_office_pids(WORD_EXE) - before)
        app.Visible = False
        app.DisplayAlerts = 0  # wdAlertsNone
        app.AutomationSecurity = MSO_SECURITY_FORCE_DISABLE
        # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles,
        #      PasswordDocument) — posicionales, ver docstring del módulo.
        doc = app.Documents.Open(str(input_path), False, True, False, _FAKE_PASSWORD)
        try:
            doc.SaveAs2(str(output_path), WD_FORMAT_PDF)
        finally:
            doc.Close(False)
    except pythoncom.com_error as exc:
        raise ValueError(_com_error_message('Word', exc, watchdog))
    finally:
        if own_instance:
            _quit(app)
        watchdog.cleanup()
        pythoncom.CoUninitialize()


def convert_excel(input_path: Path, output_path: Path) -> None:
    """XLS/XLSX/ODS → PDF con Excel COM (todas las hojas)."""
    _require_com()
    pythoncom.CoInitialize()
    before = _office_pids(EXCEL_EXE)
    watchdog = _Watchdog(EXCEL_EXE, before)
    app = None
    own_instance = False
    try:
        app = win32com.client.DispatchEx('Excel.Application')
        own_instance = bool(_office_pids(EXCEL_EXE) - before)
        app.Visible = False
        app.DisplayAlerts = False
        app.AutomationSecurity = MSO_SECURITY_FORCE_DISABLE
        # Open(FileName, UpdateLinks=0, ReadOnly=True, Format, Password)
        wb = app.Workbooks.Open(str(input_path), 0, True, None, _FAKE_PASSWORD)
        try:
            # ExportAsFixedFormat(Type, Filename) sobre el LIBRO exporta todas
            # las hojas con su configuración de impresión.
            wb.ExportAsFixedFormat(XL_TYPE_PDF, str(output_path))
        finally:
            wb.Close(False)
    except pythoncom.com_error as exc:
        raise ValueError(_com_error_message('Excel', exc, watchdog))
    finally:
        if own_instance:
            _quit(app)
        watchdog.cleanup()
        pythoncom.CoUninitialize()


def convert_powerpoint(input_path: Path, output_path: Path) -> None:
    """PPT/PPTX/ODP → PDF con PowerPoint COM.

    PowerPoint no admite `Visible = False`: se abre con WithWindow:=0. No acepta
    contraseña en Open, así que un archivo protegido termina en manos del
    watchdog (diálogo bloqueado → timeout → kill). Aceptado.
    """
    _require_com()
    pythoncom.CoInitialize()
    before = _office_pids(PPT_EXE)
    watchdog = _Watchdog(PPT_EXE, before)
    app = None
    own_instance = False
    try:
        app = win32com.client.DispatchEx('PowerPoint.Application')
        own_instance = bool(_office_pids(PPT_EXE) - before)
        app.DisplayAlerts = 1  # ppAlertsNone
        app.AutomationSecurity = MSO_SECURITY_FORCE_DISABLE
        # Open(FileName, ReadOnly=-1, Untitled=0, WithWindow=0)
        pres = app.Presentations.Open(str(input_path), -1, 0, 0)
        try:
            pres.SaveAs(str(output_path), PP_SAVEAS_PDF)
        finally:
            pres.Close()
    except pythoncom.com_error as exc:
        raise ValueError(_com_error_message('PowerPoint', exc, watchdog))
    finally:
        if own_instance:
            _quit(app)
        watchdog.cleanup()
        pythoncom.CoUninitialize()


def _quit(app) -> None:
    """Cierra la aplicación de Office (best-effort; el watchdog remata)."""
    if app is None:
        return
    try:
        app.Quit()
    except Exception:
        pass
