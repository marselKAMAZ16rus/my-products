# -*- coding: utf-8 -*-
"""
Помощник проверяющего.
Ctrl+Shift+F8: показать или скрыть окно. Поиск выполняется вручную.
Закрытие окна кнопкой X скрывает программу в фон, не завершает её.
"""
from __future__ import annotations

import re
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path
from difflib import SequenceMatcher

try:
    import keyboard
except ImportError:
    keyboard = None

APP_DIR = Path(__file__).resolve().parent
BANK_PATH = APP_DIR / "банк_комментариев.txt"
HOTKEY = "ctrl+shift+f8"
MAX_RESULTS = 12

# Небольшой словарь сокращений, которые часто встречаются при проверке ЕГЭ.
SYNONYMS = {
    "одз": ["область", "допустимых", "значений"],
    "отт": ["основное", "тригонометрическое", "тождество"],
    "пробная": ["точка", "метод", "интервалов"],
    "галочка": ["график", "модуля"],
    "ап": ["арифметическая", "прогрессия"],
    "система": ["системы", "совокупности"],
}

def split_comments(raw: str) -> list[str]:
    # Каждый непустой абзац банка — отдельный комментарий.
    blocks = re.split(r"\n\s*\n+", raw.strip())
    return [re.sub(r"[ \t]+\n", "\n", b).strip() for b in blocks if b.strip()]

def normalize(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()

def tokens(text: str) -> set[str]:
    words = set(normalize(text).split())
    expanded = set(words)
    for word in words:
        expanded.update(SYNONYMS.get(word, []))
    # Убираем совсем короткие слова, но оставляем математические обозначения.
    return {w for w in expanded if len(w) > 1}

def score_comment(query: str, comment: str) -> float:
    qn, cn = normalize(query), normalize(comment)
    if not qn:
        return 0.0
    qt, ct = tokens(query), tokens(comment)
    if not qt:
        return 0.0

    overlap = len(qt & ct) / len(qt)
    # Небольшой бонус за точное словосочетание.
    phrase_bonus = 0.22 if qn in cn else 0.0
    # Сходство полезно для опечаток и близких формулировок.
    seq = SequenceMatcher(None, qn, cn).ratio()
    # Для короткого запроса приоритет у совпадения ключевых слов.
    return min(1.0, overlap * 0.78 + phrase_bonus + seq * 0.18)

class CommentHelper:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Помощник проверяющего")
        self.root.attributes("-topmost", True)
        self.root.resizable(True, True)
        self.root.geometry("620x520")
        self.root.minsize(460, 300)
        self.root.withdraw()
        self.root.configure(bg="#f4f5f7")

        self.comments: list[str] = []
        self.load_bank()

        self.query_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ctrl + Shift + F8 — открыть / скрыть")
        self._build_ui()
        self.query_var.trace_add("write", lambda *_: self.render_results())
        self.root.bind("<Escape>", lambda e: self.hide())
        self.root.bind("<Return>", lambda e: self.render_results())
        # Крестик закрывает только окно; процесс и глобальная горячая клавиша остаются активны.
        self.root.protocol("WM_DELETE_WINDOW", self.hide)

        self.register_hotkey()

    def load_bank(self):
        if not BANK_PATH.exists():
            self.comments = []
            return
        try:
            raw = BANK_PATH.read_text(encoding="utf-8-sig")
            self.comments = split_comments(raw)
        except Exception as exc:
            messagebox.showerror("Ошибка банка", f"Не удалось прочитать файл:\n{exc}")

    def _build_ui(self):
        outer = ttk.Frame(self.root, padding=12)
        outer.pack(fill="both", expand=True)

        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(header, text="Банк комментариев", font=("Segoe UI", 14, "bold")).pack(side="left")
        ttk.Button(header, text="Обновить банк", command=self.reload_bank).pack(side="right")

        ttk.Label(outer, text="Поиск по выделенному тексту или вручную:", foreground="#555").pack(anchor="w", pady=(12, 4))
        search_row = ttk.Frame(outer)
        search_row.pack(fill="x")
        self.search_entry = ttk.Entry(search_row, textvariable=self.query_var, font=("Segoe UI", 11))
        self.search_entry.pack(side="left", fill="x", expand=True)
        ttk.Button(search_row, text="Очистить", command=lambda: self.query_var.set("")).pack(side="left", padx=(6, 0))

        self.results_canvas = tk.Canvas(outer, highlightthickness=0, bg="#f4f5f7")
        scrollbar = ttk.Scrollbar(outer, orient="vertical", command=self.results_canvas.yview)
        self.results_frame = ttk.Frame(self.results_canvas)
        self.results_frame.bind("<Configure>", lambda e: self.results_canvas.configure(scrollregion=self.results_canvas.bbox("all")))
        self.canvas_window = self.results_canvas.create_window((0, 0), window=self.results_frame, anchor="nw")
        self.results_canvas.bind("<Configure>", lambda e: self.results_canvas.itemconfigure(self.canvas_window, width=e.width))
        self.results_canvas.configure(yscrollcommand=scrollbar.set)
        self.results_canvas.pack(side="left", fill="both", expand=True, pady=(10, 0))
        scrollbar.pack(side="right", fill="y", pady=(10, 0))

        footer = ttk.Frame(outer)
        footer.pack(fill="x", pady=(8, 0))
        ttk.Label(footer, textvariable=self.status_var, foreground="#666").pack(side="left")
        ttk.Button(footer, text="Скрыть", command=self.hide).pack(side="right")

        self.render_results()

    def reload_bank(self):
        self.load_bank()
        self.status_var.set(f"Банк обновлён: {len(self.comments)} комментариев")
        self.render_results()

    def register_hotkey(self):
        if keyboard is None:
            self.status_var.set("Не установлен пакет keyboard — см. README")
            return
        try:
            keyboard.add_hotkey(HOTKEY, lambda: self.root.after(0, self.toggle_from_hotkey), suppress=False)
            self.status_var.set(f"Готово · {HOTKEY.upper()} — открыть / закрыть")
        except Exception as exc:
            self.status_var.set(f"Не удалось зарегистрировать {HOTKEY.upper()}: {exc}")

    def toggle_from_hotkey(self):
        if self.root.state() != "withdrawn":
            self.hide()
        else:
            self.show()
            self.search_entry.focus_set()

    def show(self):
        self.root.deiconify()
        self.root.attributes("-topmost", True)
        self.root.lift()
        self.root.update_idletasks()
        # Окно появляется по центру экрана.
        w, h = 620, 520
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"{w}x{h}+{max(0, (sw-w)//2)}+{max(0, (sh-h)//2)}")

    def hide(self):
        self.root.withdraw()

    def render_results(self):
        for child in self.results_frame.winfo_children():
            child.destroy()

        query = self.query_var.get().strip()
        if not query:
            ttk.Label(
                self.results_frame,
                text="Введи ключевое слово или фразу выше.\nCtrl + Shift + F8 — открыть / скрыть окно.",
                justify="center",
                foreground="#666",
                padding=24,
            ).pack(fill="x")
            return

        ranked = sorted(
            ((score_comment(query, c), c) for c in self.comments),
            key=lambda x: x[0],
            reverse=True,
        )
        ranked = [(s, c) for s, c in ranked if s >= 0.08][:MAX_RESULTS]

        if not ranked:
            ttk.Label(self.results_frame, text="Совпадений пока нет. Попробуй другое слово.", padding=18).pack(anchor="w")
            return

        for index, (score, comment) in enumerate(ranked, 1):
            card = ttk.Frame(self.results_frame, padding=9, relief="solid")
            card.pack(fill="x", pady=4)
            top = ttk.Frame(card)
            top.pack(fill="x")
            ttk.Label(top, text=f"Комментарий {index}", font=("Segoe UI", 9, "bold")).pack(side="left")
            ttk.Button(top, text="Копировать", command=lambda value=comment: self.copy_comment(value)).pack(side="right")
            preview = comment if len(comment) <= 650 else comment[:647] + "..."
            ttk.Label(card, text=preview, wraplength=540, justify="left").pack(fill="x", anchor="w", pady=(5, 0))

    def copy_comment(self, comment: str):
        try:
            self.root.clipboard_clear()
            self.root.clipboard_append(comment)
            self.root.update()
            self.status_var.set("Комментарий скопирован · вставь его сочетанием Ctrl + V")
        except tk.TclError as exc:
            self.status_var.set(f"Не удалось скопировать: {exc}")

    def run(self):
        self.root.mainloop()

def main():
    root = tk.Tk()
    app = CommentHelper(root)
    app.run()

if __name__ == "__main__":
    main()
