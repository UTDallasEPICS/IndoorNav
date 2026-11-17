
from PIL import Image
import io
import os
import fitz 

# this function presumes that the last page is the one we want to return. 
# this does not return a list of images, since the pdfs tend to only be one page
def convert_pdf_to_png(file_path, output_dir, png_name):
    os.makedirs(output_dir, exist_ok=True)

    doc = fitz.open(file_path)

    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=200)

        if png_name is not None and output_dir is not None:
            output_path = os.path.join(output_dir, f"{png_name}_{i}.png")
            pix.save(output_path)
      
    print(f"Successfully parsed {len(doc)} page(s) to PNG.")
    return Image.open(io.BytesIO(pix.tobytes("png")))  

        
