// Whole-window drag and drop, the file picker, and the toast.

const dropzone = () => document.getElementById('dropzone');

export function bindDropzone(onFile) {
  let depth = 0;

  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    dropzone().classList.add('is-visible');
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      dropzone().classList.remove('is-visible');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    dropzone().classList.remove('is-visible');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });

  const input = document.getElementById('fileInput');
  document.getElementById('browseBtn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
    input.value = '';  // so re-picking the same file fires again
  });
}

let toastTimer;
export function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2600);
}
