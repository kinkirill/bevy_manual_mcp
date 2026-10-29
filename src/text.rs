//! Tantivy text index built alongside the rkyv corpus.
//!
//! Tantivy stores record ids only; every byte of payload stays in
//! `corpus.rkyv`. The custom tokenizer splits Rust identifiers so
//! `add_systems`, `AddSystems` and `add systems` meet.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result, anyhow};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, Schema, TantivyDocument, Term,
    TextFieldIndexing, TextOptions, Value,
};
use tantivy::tokenizer::{BoxTokenStream, Token, TokenStream, Tokenizer};
use tantivy::{Index, IndexReader, doc};

use crate::archive::{Corpus, split_name_tokens};

pub const TEXT_DIR: &str = "tantivy";
const TOKENIZER: &str = "bevy_ident";

/// Field boosts for the query; name matches outrank prose, as before.
const FIELD_BOOSTS: [(&str, f32); 3] = [("name", 4.0), ("signature", 2.0), ("docs", 1.0)];

pub const QUERY_STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "with", "from",
    "into", "as", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "how",
    "what", "which", "when", "where", "why", "who", "i", "me", "my", "we", "you", "your", "it",
    "its", "this", "that", "these", "those", "can", "could", "should", "would", "will", "make",
    "makes", "made", "use", "uses", "used", "using", "get", "gets", "getting", "want", "need",
    "there", "here", "if", "then", "than", "so", "but", "not", "no", "yes", "please", "help",
    "between",
];

#[derive(Clone, Copy)]
pub struct Fields {
    pub id: Field,
    pub name: Field,
    pub signature: Field,
    pub docs: Field,
}

impl Fields {
    fn from_schema(schema: &Schema) -> Result<Self> {
        Ok(Self {
            id: schema
                .get_field("id")
                .map_err(|_| anyhow!("text index schema is missing the id field"))?,
            name: schema
                .get_field("name")
                .map_err(|_| anyhow!("text index schema is missing the name field"))?,
            signature: schema
                .get_field("signature")
                .map_err(|_| anyhow!("text index schema is missing the signature field"))?,
            docs: schema
                .get_field("docs")
                .map_err(|_| anyhow!("text index schema is missing the docs field"))?,
        })
    }
}

pub struct TextIndex {
    reader: IndexReader,
    fields: Fields,
}

impl TextIndex {
    pub fn open(dir: &Path) -> Result<Self> {
        let index = Index::open_in_dir(dir)
            .with_context(|| format!("cannot open text index at {}", dir.display()))?;
        let fields = Fields::from_schema(&index.schema())?;
        let reader = index.reader()?;
        Ok(Self { reader, fields })
    }

    pub fn doc_count(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// BM25 over the three fields, best first: `(dense record id, score)`.
    ///
    /// Strict (all terms must appear) first, then relaxed (any term), like the
    /// TypeScript server's strict/relaxed text pass.
    pub fn search(&self, query: &str, pool: usize) -> Result<Vec<(u32, f32)>> {
        let terms = query_terms(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let mut out: Vec<(u32, f32)> = Vec::new();
        let mut seen: Vec<u32> = Vec::new();

        for occur in [Occur::Must, Occur::Should] {
            let clauses: Vec<(Occur, Box<dyn Query>)> = terms
                .iter()
                .map(|term| (occur, self.term_group(term)))
                .collect();
            let query = BooleanQuery::new(clauses);
            let top =
                searcher.search(&query, &TopDocs::with_limit(pool.max(1)).order_by_score())?;
            for (score, address) in top {
                let document: TantivyDocument = searcher.doc(address)?;
                let Some(id) = document
                    .get_first(self.fields.id)
                    .and_then(|value| value.as_u64())
                else {
                    continue;
                };
                let id = id as u32;
                if seen.contains(&id) {
                    continue;
                }
                seen.push(id);
                out.push((id, score));
            }
        }
        Ok(out)
    }

    /// One term across all three fields, with field boosts.
    fn term_group(&self, term: &str) -> Box<dyn Query> {
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
        for (field_name, boost) in FIELD_BOOSTS {
            let field = match field_name {
                "name" => self.fields.name,
                "signature" => self.fields.signature,
                _ => self.fields.docs,
            };
            let term_query = TermQuery::new(
                Term::from_field_text(field, term),
                IndexRecordOption::WithFreqs,
            );
            clauses.push((
                Occur::Should,
                Box::new(BoostQuery::new(Box::new(term_query), boost)),
            ));
        }
        Box::new(BooleanQuery::new(clauses))
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_u64_field("id", FAST | STORED | INDEXED);

    let ident_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER)
        .set_index_option(IndexRecordOption::WithFreqs);
    let ident = TextOptions::default().set_indexing_options(ident_indexing);
    builder.add_text_field("name", ident.clone());
    builder.add_text_field("signature", ident.clone());
    // Prose keeps tantivy's default analyzer (simple + lowercase + long filter).
    builder.add_text_field(
        "docs",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("default")
                .set_index_option(IndexRecordOption::WithFreqs),
        ),
    );
    builder.build()
}

#[derive(Debug)]
pub struct TextBuildReport {
    pub documents: usize,
    pub bytes: u64,
}

/// Build (or rebuild) the text index for an unarchived corpus.
pub fn build_index(corpus: &Corpus, dir: &Path) -> Result<TextBuildReport> {
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("cannot clear {}", dir.display()))?;
    }
    fs::create_dir_all(dir)?;

    let schema = build_schema();
    let index = Index::create_in_dir(dir, schema)?;
    index.tokenizers().register(TOKENIZER, IdentifierTokenizer);
    let fields = Fields::from_schema(&index.schema())?;

    let mut writer = index.writer_with_num_threads::<TantivyDocument>(1, 512_000_000)?;
    let mut documents = 0usize;
    for (id, record) in corpus.records.iter().enumerate() {
        // Fields are excluded from full-text search (exact lookup still finds them).
        if corpus.string(record.kind) == "field" {
            continue;
        }
        writer.add_document(doc!(
            fields.id => id as u64,
            fields.name => corpus.string(record.name).to_string(),
            fields.signature => corpus.string(record.signature).to_string(),
            fields.docs => corpus.string(record.docs).to_string(),
        ))?;
        documents += 1;
    }
    writer.commit()?;
    drop(writer);

    Ok(TextBuildReport {
        documents,
        bytes: dir_size(dir),
    })
}

pub fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                dir_size(&path)
            } else {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// Terms used to query the text index: the same identifier splitting the index
/// uses, plus a singular form so `systems` also finds `system`.
pub fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in query
        .to_lowercase()
        .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
    {
        if word.len() < 2 || QUERY_STOPWORDS.contains(&word) {
            continue;
        }
        push_term(&mut terms, word);
        push_term(&mut terms, &singular(word));
        for part in split_name_tokens(word) {
            push_term(&mut terms, &part);
        }
    }
    terms
}

fn push_term(terms: &mut Vec<String>, term: &str) {
    if term.len() > 1 && !terms.iter().any(|existing| existing == term) {
        terms.push(term.to_string());
    }
}

fn singular(term: &str) -> String {
    if term.len() > 4 && term.ends_with("ies") {
        return format!("{}y", &term[..term.len() - 3]);
    }
    if term.ends_with("ches")
        || term.ends_with("shes")
        || term.ends_with("xes")
        || term.ends_with("zes")
    {
        return term[..term.len() - 2].to_string();
    }
    if term.len() > 3 && term.ends_with('s') && !term.ends_with("ss") && !term.ends_with("us") {
        return term[..term.len() - 1].to_string();
    }
    term.to_string()
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct IdentifierTokenizer;

impl Tokenizer for IdentifierTokenizer {
    type TokenStream<'a> = BoxTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut tokens = Vec::new();
        let mut position = 0usize;
        let mut offset = 0usize;
        for raw in text.split(|ch: char| !(ch.is_alphanumeric() || ch == '_')) {
            if raw.is_empty() {
                continue;
            }
            let lowered = raw.to_lowercase();
            tokens.push(Token {
                offset_from: offset,
                offset_to: offset + raw.len(),
                position,
                text: lowered.clone(),
                position_length: 1,
            });
            position += 1;
            for part in split_name_tokens(raw) {
                if part.is_empty() || part == lowered {
                    continue;
                }
                tokens.push(Token {
                    offset_from: offset,
                    offset_to: offset + raw.len(),
                    position,
                    text: part,
                    position_length: 1,
                });
                position += 1;
            }
            offset += raw.len() + 1;
        }
        BoxTokenStream::new(VecTokenStream { tokens, cursor: -1 })
    }
}

struct VecTokenStream {
    tokens: Vec<Token>,
    cursor: isize,
}

impl TokenStream for VecTokenStream {
    fn advance(&mut self) -> bool {
        self.cursor += 1;
        (self.cursor as usize) < self.tokens.len()
    }

    fn token(&self) -> &Token {
        &self.tokens[self.cursor as usize]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.cursor as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_terms_drop_stopwords_and_split_identifiers() {
        let terms = query_terms("How to spawn a Camera2d");
        assert!(terms.contains(&"spawn".to_string()));
        assert!(terms.contains(&"camera".to_string()));
        assert!(terms.contains(&"camera2d".to_string()));
        assert!(!terms.contains(&"how".to_string()));
        assert!(!terms.contains(&"to".to_string()));
    }

    #[test]
    fn tokenizer_emits_whole_and_split_tokens() {
        let mut tokenizer = IdentifierTokenizer;
        let mut stream = tokenizer.token_stream("AddSystems");
        let mut seen = Vec::new();
        stream.process(&mut |token| seen.push(token.text.clone()));
        assert!(seen.contains(&"addsystems".to_string()), "{seen:?}");
        assert!(seen.contains(&"add".to_string()), "{seen:?}");
        assert!(seen.contains(&"system".to_string()), "{seen:?}");
    }
}
