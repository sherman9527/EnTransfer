from PIL import Image
import os

src = r'C:\Users\_Cole\Desktop\ADEMO\EnTransfer\assets\icon.png'
dst = r'C:\Users\_Cole\Desktop\ADEMO\EnTransfer\assets\icon.ico'

img = Image.open(src)
if img.mode != 'RGBA':
    img = img.convert('RGBA')

sizes = [(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)]
img.save(dst, format='ICO', sizes=sizes)

print('ICO generated successfully')
print(f'icon.png: {os.path.getsize(src)//1024}KB')
print(f'icon.ico: {os.path.getsize(dst)//1024}KB')
