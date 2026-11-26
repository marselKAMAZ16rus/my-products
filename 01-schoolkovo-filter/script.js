// ==========================================
// НАСТРОЙКИ
// ==========================================
const myHomeworkIds = [
    17534,
    32624,
    32988,
    32999,
    33120,
    33160,
    33302,
    33333,
    33484,
    33472,
    33523,
    33716,
    33627,
    33708,
    33573,
    33909,
    33970,
    34000,
    34458,
    34801,
    35751,
    36101,
    36343,
    36285,
    36553,
    36543,
    36848,
    36910,
    37017,
    37103,
    37263,
    37561,
    37645,
    37779,
    37770,
    36779
    // Впиши сюда свои ID через запятую
];

// На сколько дней задача считается просроченной
const OLD_TASK_DAYS_THRESHOLD = 2; 

// --- Цвета ---

// 1. Желтый (для моих свежих задач)
const COLOR_MY_BG = '#fff9c4';    
const COLOR_MY_BORDER = '#fbc02d'; 

// 2. Красный (для моих просроченных задач)
// Светло-красный фон (Material Red 100)
const COLOR_OLD_BG = '#ffcdd2';   
// Темно-красный текст для контраста (Material Red 900)
const COLOR_OLD_TEXT = '#b71c1c'; 
const COLOR_OLD_BORDER = '#e57373';
// ==========================================

let observer = null;
let debounceTimer = null;
let sentColumnIndex = null; 

// 1. Ищем колонку "Отправлено"
function findSentColumnIndex() {
    if (sentColumnIndex !== null) return sentColumnIndex;

    const headers = document.querySelectorAll('div[role="columnheader"]');
    for (let th of headers) {
        if (th.textContent.includes('Отправлено')) {
            const indexStr = th.getAttribute('aria-colindex');
            if (indexStr) {
                sentColumnIndex = parseInt(indexStr, 10);
                return sentColumnIndex;
            }
        }
    }
    return null;
}

// 2. Проверяем дату
function isDateOld(dateString) {
    if (!dateString) return false;
    
    const datePart = dateString.split(' ')[0]; 
    const parts = datePart.split('.'); 
    
    if (parts.length !== 3) return false;

    const sentDate = new Date(parts[2], parts[1] - 1, parts[0]);
    const now = new Date();

    now.setHours(0, 0, 0, 0);
    sentDate.setHours(0, 0, 0, 0);

    const diffTime = now - sentDate;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

    return diffDays >= OLD_TASK_DAYS_THRESHOLD;
}

// 3. Основная функция подсветки
function highlightMyRows() {
    const rows = document.querySelectorAll('div[role="row"]');
    const targetColIndex = findSentColumnIndex();
    
    rows.forEach(row => {
        // --- ШАГ 1: Проверяем, моя ли это задача ---
        const idCell = row.querySelector('div[role="gridcell"][aria-colindex="6"]');
        let isMyTask = false;
        let taskId = null;
        
        if (idCell) {
            taskId = parseInt(idCell.textContent.trim(), 10);
            if (myHomeworkIds.includes(taskId)) {
                isMyTask = true;
            }
        }

        // --- ШАГ 2: Применяем стили ---
        
        // Сначала сбрасываем стили (чтобы убрать цвет, если задача больше не моя или дата изменилась)
        row.style.backgroundColor = '';
        row.style.fontWeight = '';
        row.style.borderLeft = '';
        
        // Сброс цвета текста для всех ячеек строки
        const cells = row.querySelectorAll('div[role="gridcell"]');
        cells.forEach(c => c.style.color = '');

        if (isMyTask) {
            // Если это моя задача, проверяем дату
            let isOld = false;
            if (targetColIndex) {
                const sentCell = row.querySelector(`div[role="gridcell"][aria-colindex="${targetColIndex}"]`);
                if (sentCell && isDateOld(sentCell.textContent)) {
                    isOld = true;
                }
            }

            if (isOld) {
                // --- ПРОСРОЧЕННАЯ МОЯ ЗАДАЧА (КРАСНЫЙ) ---
                row.style.backgroundColor = COLOR_OLD_BG;
                row.style.borderLeft = `5px solid ${COLOR_OLD_BORDER}`;
                // Красим текст в темно-красный для читаемости
                cells.forEach(c => c.style.color = COLOR_OLD_TEXT);
            } else {
                // --- СВЕЖАЯ МОЯ ЗАДАЧА (ЖЕЛТЫЙ) ---
                row.style.backgroundColor = COLOR_MY_BG;
                row.style.fontWeight = 'bold';
                row.style.borderLeft = `5px solid ${COLOR_MY_BORDER}`;
            }
        }
        // Если isMyTask === false, ничего не делаем (строка остается стандартной)
    });
}

function scheduleHighlight() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(highlightMyRows, 300);
}

function startObserving() {
    highlightMyRows();

    if (!observer) {
        observer = new MutationObserver(scheduleHighlight);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
} else {
    startObserving();
}