

use std::{error::Error, fs};

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use js::{
	Rewriter,
	cfg::{Config, Flags, UrlRewriter},
};
use oxc::allocator::{Allocator, StringBuilder};

struct PrefixUrl;

impl UrlRewriter for PrefixUrl {
	fn rewrite(
		&self,
		_cfg: &Config,
		_flags: &Flags,
		url: &str,
		builder: &mut StringBuilder,
		_module: bool,
	) -> Result<(), Box<dyn Error + Sync + Send>> {
		builder.push_str("/~/sj/");
		builder.push_str(url);
		Ok(())
	}
}

fn config() -> Config {
	let s = |x: &str| x.to_string();
	Config {
		prefix: s("/~/sj/"),
		wrapfn: s("$wrap"),
		wrappropertybase: s("$sj_"),
		wrappropertyfn: s("$prop"),
		cleanrestfn: s("$clean"),
		importfn: s("$import"),
		rewritefn: s("$rewrite"),
		wrappostmessagefn: s("$wrapPostMessage"),
		metafn: s("$meta"),
		pushsourcemapfn: s("$pushsourcemap"),
		trysetfn: s("$tryset"),
		templocid: s("$temploc"),
		tempunusedid: s("$tempunused"),
	}
}

fn flags(sourcemaps: bool) -> Flags {
	Flags {
		base: "https://example.com/app.js".to_string(),
		sourcetag: "bench".to_string(),
		is_module: false,
		capture_errors: false,
		scramitize: false,
		do_sourcemaps: sourcemaps,
		disable_computed_wrap: false,
		destructure_rewrites: false,
	}
}

fn bench_file(c: &mut Criterion, name: &str, path: &str) {
	let src = fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
	let mut group = c.benchmark_group("rewrite_js");
	group.throughput(Throughput::Bytes(src.len() as u64));
	group.sample_size(20);
	for (label, maps) in [("nomap", false), ("sourcemap", true)] {
		group.bench_function(format!("{name}/{label}"), |b| {
			let rewriter = Rewriter::new();
			b.iter_batched(
				Allocator::new,
				|alloc| {
					let out = rewriter
						.rewrite(&alloc, &src, config(), flags(maps), &PrefixUrl)
						.expect("rewrite");
					std::hint::black_box(out.js.len())
				},
				BatchSize::PerIteration,
			);
		});
	}
	group.finish();
}

fn benches(c: &mut Criterion) {
	let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../native/sample");
	bench_file(c, "google", &format!("{dir}/google.js"));
	bench_file(c, "discord", &format!("{dir}/discord.js"));
}

criterion_group!(rewrite, benches);
criterion_main!(rewrite);
