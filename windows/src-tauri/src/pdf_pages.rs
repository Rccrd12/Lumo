//! A PDF's first pages as pictures, for a model that sees (pdf_text.rs gives
//! their text): drawn by Windows itself (Windows.Data.Pdf), as PNG, with
//! nothing added to Lumo. Elsewhere, and for a file Windows can't open (a
//! password, a damaged file), there are none.

/// How wide a page is drawn, in pixels: its words legible, its picture small.
#[cfg(windows)]
const WIDTH: u32 = 1024;

/// The first `max` pages of the PDF at `path`, each a PNG.
pub fn render(path: &str, max: u32) -> Vec<Vec<u8>> {
    #[cfg(windows)]
    {
        imp::render(path, max).unwrap_or_else(|e| {
            crate::log::line(format!("[pdf] {path}: {}", e.message()));
            Vec::new()
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (path, max);
        Vec::new()
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};

    pub fn render(path: &str, max: u32) -> windows::core::Result<Vec<Vec<u8>>> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.get()?;
        let doc = PdfDocument::LoadFromFileAsync(&file)?.get()?;
        let mut pages = Vec::new();
        for i in 0..doc.PageCount()?.min(max) {
            let page = doc.GetPage(i)?;
            let size = page.Size()?;
            let options = PdfPageRenderOptions::new()?;
            if size.Width > 0.0 && size.Height > 0.0 {
                options.SetDestinationWidth(super::WIDTH)?;
                // A very long page keeps a height a model takes.
                options.SetDestinationHeight(((size.Height / size.Width) * super::WIDTH as f32).clamp(1.0, 4.0 * super::WIDTH as f32) as u32)?;
            }
            let stream = InMemoryRandomAccessStream::new()?;
            page.RenderWithOptionsToStreamAsync(&stream, &options)?.get()?;
            let len = u32::try_from(stream.Size()?).unwrap_or(0);
            if len == 0 {
                continue;
            }
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            reader.LoadAsync(len)?.get()?;
            let mut bytes = vec![0u8; len as usize];
            reader.ReadBytes(&mut bytes)?;
            pages.push(bytes);
        }
        Ok(pages)
    }
}
