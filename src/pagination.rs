//! Opaque, query-bound cursors for resource listings.

use sha2::{Digest, Sha256};

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 200;

pub struct Page<'a, T> {
    pub items: &'a [T],
    pub next_cursor: Option<String>,
    pub page_size: usize,
    pub total: usize,
}

/// Paginate by offset, binding the cursor to the query that produced it.
pub fn paginate<'a, T>(
    items: &'a [T],
    query: &str,
    cursor: Option<&str>,
    requested_size: Option<usize>,
) -> Result<Page<'a, T>, String> {
    let page_size = requested_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let query_id = fingerprint(query);
    let mut offset = 0usize;
    if let Some(cursor) = cursor {
        let (raw_offset, raw_query) = cursor
            .split_once('.')
            .ok_or_else(|| "Invalid cursor".to_string())?;
        let parsed: usize = raw_offset
            .parse()
            .map_err(|_| "Invalid cursor".to_string())?;
        if parsed > items.len() {
            return Err("Invalid cursor".to_string());
        }
        if raw_query != query_id {
            return Err(
                "Cursor does not belong to this query; restart the listing without a cursor."
                    .to_string(),
            );
        }
        offset = parsed;
    }
    let end = (offset + page_size).min(items.len());
    let next_cursor = (end < items.len()).then(|| format!("{end}.{query_id}"));
    Ok(Page {
        items: &items[offset..end],
        next_cursor,
        page_size,
        total: items.len(),
    })
}

fn fingerprint(query: &str) -> String {
    let digest = Sha256::digest(query.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_and_binds_the_cursor_to_the_query() {
        let items: Vec<u32> = (0..120).collect();
        let first = paginate(&items, "kind:struct", None, Some(50)).unwrap();
        assert_eq!(first.items.len(), 50);
        assert_eq!(first.total, 120);
        let cursor = first.next_cursor.clone().unwrap();

        let second = paginate(&items, "kind:struct", Some(&cursor), Some(50)).unwrap();
        assert_eq!(second.items.first(), Some(&50));

        let wrong = paginate(&items, "kind:enum", Some(&cursor), Some(50));
        assert!(wrong.is_err());
    }
}
