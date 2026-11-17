import pdf2image

import tkinter as tk
from tkinter import filedialog
import numpy as np
from PIL import Image, ImageTk

class MatrixTextEditor:
    def __init__(self, root, file_path):
        self.root = root
        self.root.title("Matrix Text File Editor")
        self.file_path = file_path
        
        # 1. Load the matrix from the text file using NumPy
        try:
            self.matrix = np.loadtxt(self.file_path, dtype=int)
        except Exception as e:
            print(f"Error loading matrix: {e}")
            self.matrix = np.zeros((100, 100), dtype=int)

        self.height, self.width = self.matrix.shape
        
        # Normalize matrix values for display if they are 0 and 1
        self.val_max = self.matrix.max()
        if self.val_max <= 1:
            self.display_scale = 255
        else:
            self.display_scale = 1
            
        self.brush_size = 3
        self.draw_value = 0  # Default to drawing black (erasing artifacts)
        
        # Zoom & Pan State variables
        self.zoom_scale = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0
        self.drag_start_x = 0
        self.drag_start_y = 0
        
        # Stroke tracking for interpolation
        self.last_img_x = None
        self.last_img_y = None
        
        # Cursor preview item reference
        self.cursor_rect = None
        
        # Caching for performance
        self._cached_zoom = None
        self._cached_tk_img = None

        # Undo / Redo History Stacks
        self.undo_stack = []
        self.redo_stack = []
        self.max_history = 30
        
        self.setup_ui()
        self.update_canvas()

    def setup_ui(self):
        # Control Panel
        control_frame = tk.Frame(self.root, bg="#f0f0f0", pady=5)
        control_frame.pack(side=tk.TOP, fill=tk.X)
        
        tk.Button(control_frame, text="Eraser / Black (0)", command=lambda: self.set_draw_value(0), bg="#ffcccc", font=("Arial", 10, "bold")).pack(side=tk.LEFT, padx=5)
        tk.Button(control_frame, text="Draw / White (1/Max)", command=lambda: self.set_draw_value(1), bg="#ccffcc", font=("Arial", 10, "bold")).pack(side=tk.LEFT, padx=5)
        
        tk.Label(control_frame, text="Brush Size:", bg="#f0f0f0").pack(side=tk.LEFT, padx=10)
        self.size_slider = tk.Scale(control_frame, from_=1, to=20, orient=tk.HORIZONTAL, command=self.update_brush)
        self.size_slider.set(self.brush_size)
        self.size_slider.pack(side=tk.LEFT, padx=5)
        
        tk.Button(control_frame, text="Reset View", command=self.reset_view, bg="#e0e0e0", font=("Arial", 10, "bold")).pack(side=tk.LEFT, padx=10)
        tk.Button(control_frame, text="Save Matrix to .txt", command=self.save_matrix, bg="#cce5ff", font=("Arial", 10, "bold")).pack(side=tk.RIGHT, padx=5)

        # Canvas Area for the Image
        canvas_frame = tk.Frame(self.root)
        canvas_frame.pack(fill=tk.BOTH, expand=True)
        
        self.canvas = tk.Canvas(canvas_frame, bg="gray", highlightthickness=0)
        self.canvas.pack(fill=tk.BOTH, expand=True)
        
        # Bind Mouse Actions for Painting (Left Click & Drag)
        self.canvas.bind("<Button-1>", self.start_stroke)      
        self.canvas.bind("<B1-Motion>", self.paint)
        self.canvas.bind("<ButtonRelease-1>", self.end_stroke)

        # Bind Mouse Actions for Panning (Scrollwheel / Middle Click / Right Click)
        self.canvas.bind("<Button-2>", self.start_pan)
        self.canvas.bind("<B2-Motion>", self.do_pan)
        self.canvas.bind("<Button-3>", self.start_pan)
        self.canvas.bind("<B3-Motion>", self.do_pan)

        # Bind Mouse Wheel for Zooming
        self.canvas.bind("<MouseWheel>", self.zoom)     # Windows and macOS
        self.canvas.bind("<Button-4>", self.zoom)       # Linux scroll up
        self.canvas.bind("<Button-5>", self.zoom)       # Linux scroll down

        # Bind Cursor Hover Preview Events & Hide OS Mouse
        self.canvas.bind("<Motion>", self.update_cursor)
        self.canvas.bind("<Enter>", self.show_cursor)
        self.canvas.bind("<Leave>", self.hide_cursor)

        # Bind Keyboard Shortcuts for Undo (Ctrl+Z / Cmd+Z) and Redo (Ctrl+Y / Ctrl+Shift+Z)
        self.root.bind("<Control-z>", self.undo)
        self.root.bind("<Command-z>", self.undo)  # macOS support
        self.root.bind("<Control-y>", self.redo)
        self.root.bind("<Control-Shift-Z>", self.redo)

    def set_draw_value(self, val):
        if val == 1 and self.val_max > 1:
            self.draw_value = self.val_max
        else:
            self.draw_value = val

    def update_brush(self, val):
        self.brush_size = int(val)

    def reset_view(self):
        self.zoom_scale = 1.0
        self.pan_x = 0.0
        self.pan_y = 0.0
        self.update_canvas()

    def push_undo_state(self):
        # Save a copy of the matrix before changes for undo history
        self.undo_stack.append(self.matrix.copy())
        if len(self.undo_stack) > self.max_history:
            self.undo_stack.pop(0)
        # Clear redo stack on new user action
        self.redo_stack.clear()

    def undo(self, event=None):
        if not self.undo_stack:
            return
        # Push current state to redo stack
        self.redo_stack.append(self.matrix.copy())
        # Pop previous state from undo stack
        self.matrix = self.undo_stack.pop()
        self.update_canvas(matrix_changed=True)

    def redo(self, event=None):
        if not self.redo_stack:
            return
        # Push current state to undo stack
        self.undo_stack.append(self.matrix.copy())
        # Pop next state from redo stack
        self.matrix = self.redo_stack.pop()
        self.update_canvas(matrix_changed=True)

    def update_canvas(self, matrix_changed=False):
        scaled_matrix = (self.matrix * self.display_scale).astype(np.uint8)
        pil_img = Image.fromarray(scaled_matrix)
        
        new_width = max(1, int(self.width * self.zoom_scale))
        new_height = max(1, int(self.height * self.zoom_scale))
        
        if matrix_changed or self._cached_zoom != self.zoom_scale or self._cached_tk_img is None:
            resized_pil = pil_img.resize((new_width, new_height), Image.NEAREST)
            self._cached_tk_img = ImageTk.PhotoImage(resized_pil)
            self._cached_zoom = self.zoom_scale

        self.canvas.delete("all")
        self.image_item = self.canvas.create_image(self.pan_x, self.pan_y, anchor=tk.NW, image=self._cached_tk_img)

        # Recreate cursor preview rect if active
        if self.cursor_rect is not None:
            self.cursor_rect = self.canvas.create_rectangle(0, 0, 0, 0, outline="red", width=1)

    def show_cursor(self, event):
        # Hide standard OS mouse cursor inside canvas
        self.canvas.config(cursor="none")
        if self.cursor_rect is None:
            self.cursor_rect = self.canvas.create_rectangle(0, 0, 0, 0, outline="red", width=1)
        self.update_cursor(event)

    def hide_cursor(self, event):
        # Restore standard OS mouse cursor when leaving canvas area
        self.canvas.config(cursor="")
        if self.cursor_rect is not None:
            self.canvas.delete(self.cursor_rect)
            self.cursor_rect = None

    def update_cursor(self, event):
        if self.cursor_rect is None:
            self.show_cursor(event)
            
        img_x = (event.x - self.pan_x) / self.zoom_scale
        img_y = (event.y - self.pan_y) / self.zoom_scale
        
        x, y = int(img_x), int(img_y)
        r = self.brush_size
        
        x1 = (x - r) * self.zoom_scale + self.pan_x
        y1 = (y - r) * self.zoom_scale + self.pan_y
        x2 = (x + r) * self.zoom_scale + self.pan_x
        y2 = (y + r) * self.zoom_scale + self.pan_y
        
        self.canvas.coords(self.cursor_rect, x1, y1, x2, y2)

    def start_pan(self, event):
        self.drag_start_x = event.x
        self.drag_start_y = event.y

    def do_pan(self, event):
        dx = event.x - self.drag_start_x
        dy = event.y - self.drag_start_y
        self.pan_x += dx
        self.pan_y += dy
        self.drag_start_x = event.x
        self.drag_start_y = event.y
        
        self.canvas.coords(self.image_item, self.pan_x, self.pan_y)
        self.update_cursor(event)

    def zoom(self, event):
        if event.num == 4 or event.delta > 0:
            zoom_factor = 1.15
        elif event.num == 5 or event.delta < 0:
            zoom_factor = 1 / 1.15
        else:
            zoom_factor = 1.0

        old_zoom = self.zoom_scale
        new_zoom = self.zoom_scale * zoom_factor
        
        if new_zoom < 0.1 or new_zoom > 50.0:
            return

        self.zoom_scale = new_zoom
        self.pan_x = event.x - (event.x - self.pan_x) * (self.zoom_scale / old_zoom)
        self.pan_y = event.y - (event.y - self.pan_y) * (self.zoom_scale / old_zoom)

        self.update_canvas(matrix_changed=False)
        self.update_cursor(event)

    def start_stroke(self, event):
        # Save state to undo history before starting stroke modifications
        self.push_undo_state()
        
        img_x = (event.x - self.pan_x) / self.zoom_scale
        img_y = (event.y - self.pan_y) / self.zoom_scale
        self.last_img_x = img_x
        self.last_img_y = img_y
        self.paint(event)

    def paint(self, event):
        img_x = (event.x - self.pan_x) / self.zoom_scale
        img_y = (event.y - self.pan_y) / self.zoom_scale
        
        if self.last_img_x is None or self.last_img_y is None:
            self.last_img_x = img_x
            self.last_img_y = img_y

        dist = np.hypot(img_x - self.last_img_x, img_y - self.last_img_y)
        steps = max(1, int(dist))
        
        xs = np.linspace(self.last_img_x, img_x, steps)
        ys = np.linspace(self.last_img_y, img_y, steps)
        
        matrix_val = self.draw_value if self.display_scale == 1 else (1 if self.draw_value > 0 else 0)
        r = self.brush_size
        
        for cx, cy in zip(xs, ys):
            x, y = int(cx), int(cy)
            y1, y2 = max(0, y - r), min(self.height, y + r)
            x1, x2 = max(0, x - r), min(self.width, x + r)
            self.matrix[y1:y2, x1:x2] = matrix_val
            
        self.last_img_x = img_x
        self.last_img_y = img_y
        
        self.update_canvas(matrix_changed=True)
        self.update_cursor(event)

    def end_stroke(self, event):
        self.last_img_x = None
        self.last_img_y = None

    def save_matrix(self):
        save_path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            initialfile=self.file_path,
            filetypes=[("Text Files", "*.txt"), ("All Files", "*.*")]
        )
        if save_path:
            np.savetxt(save_path, self.matrix, fmt="%d")
            print(f"Matrix successfully saved to {save_path}")

if __name__ == "__main__":
    root = tk.Tk()
    root.geometry("900x700")
    
    target_txt_file = r"file_io/line_img_matrix.txt"
    
    app = MatrixTextEditor(root, target_txt_file)
    root.mainloop()