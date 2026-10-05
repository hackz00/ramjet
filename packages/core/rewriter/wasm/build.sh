#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit



if ! [ "${RELEASE:-0}" = "1" ]; then
	WASMOPTFLAGS="${WASMOPTFLAGS:-} -g"
	FEATURES="debug,${FEATURES:-}"
else
	: "${WASMOPTFLAGS:=}"
	: "${FEATURES:=}"
fi

MODE="release"
if [ "${RELEASE:-0}" != "1" ]; then MODE="debug"; fi
# Ramjet: "speed" (default) tunes for runtime speed; "size" restores the upstream size-optimized build.
PROFILE="${RAMJET_WASM_PROFILE:-speed}"
if [ "$PROFILE" != "speed" ] && [ "$PROFILE" != "size" ]; then echo "RAMJET_WASM_PROFILE must be speed|size"; exit 1; fi
# shellcheck disable=SC2046
SRC_HASH=$( (echo "MODE=${MODE}"; echo "PROFILE=${PROFILE}"; sha256sum $(find ../ -type f -not -path "*/\.*" -and \( -name "*.rs" -o -name "*.toml" -o -name "*.sh" -o -name "*.json" -o -name "*.md" \); echo Cargo.toml; echo build.sh) 2>/dev/null | sort -k2 | sha256sum ) | sha256sum | cut -d' ' -f1 ) || SRC_HASH="unknown"

if [ -f out/.build-hash ] && [ -f ../../dist/ramjet.wasm ] && [ "$SRC_HASH" != "unknown" ] && grep -q "$SRC_HASH" out/.build-hash; then
  echo "Rewriter sources unchanged (hash $SRC_HASH); skipping rebuild."
  exit 0
fi

which cargo wasm-bindgen wasm-opt wasm-snip &> /dev/null || {
	echo "Please install cargo, wasm-bindgen, wasm-opt from https://github.com/WebAssembly/binaryen, and wasm-snip from https://github.com/r58playz/wasm-snip!"
	exit 1
}

WBG="wasm-bindgen 0.2.105"
if ! [[ "$(wasm-bindgen -V)" =~ ^"$WBG" ]]; then
	echo "Incorrect wasm-bindgen-cli version: '$(wasm-bindgen -V)' != '$WBG'"
	exit 1
fi

(
	export RUSTFLAGS='-Zlocation-detail=none -Zfmt-debug=none'
	STD_FEATURES=""
	if [ "$PROFILE" = "size" ]; then
		RUSTFLAGS="${RUSTFLAGS} -C opt-level=z"
		STD_FEATURES="optimize_for_size"
	else
		RUSTFLAGS="${RUSTFLAGS} -C target-feature=+simd128,+bulk-memory,+sign-ext"
	fi
	if [ "${OPTIMIZE_FOR_SIZE:-0}" = "1" ]; then
		RUSTFLAGS="${RUSTFLAGS} -C opt-level=z"
	fi
	export RUSTFLAGS
	STD_FEATURE_ARGS=()
	if [ -n "$STD_FEATURES" ]; then STD_FEATURE_ARGS=(-Z "build-std-features=${STD_FEATURES}"); fi
	cargo +nightly build --release --target wasm32-unknown-unknown 		-Z build-std=panic_abort,std "${STD_FEATURE_ARGS[@]}" 		--no-default-features --features "$FEATURES"
)
wasm-bindgen --target web --out-dir out/ ../target/wasm32-unknown-unknown/release/wasm.wasm

if [[ "$OSTYPE" == "darwin"* ]] || [[ "$OSTYPE" == "freebsd"* ]] || [[ "$OSTYPE" == "dragonfly"* ]]; then
	sed -i '' 's/import.meta.url/""/g' out/wasm.js
else
	sed -i 's/import.meta.url/""/g' out/wasm.js
fi

# Ramjet: a module compiled in another same-origin realm (the controller page) fails `instanceof` against this
# realm's WebAssembly.Module; check the brand instead so frames can reuse the controller's compiled module.
sed -i 's/if (!(module instanceof WebAssembly.Module)) {/if (Object.prototype.toString.call(module) !== "[object WebAssembly.Module]") {/' out/wasm.js
grep -q 'object WebAssembly.Module' out/wasm.js || { echo "failed to patch wasm.js module brand check"; exit 1; }

cd ../../

wasm-snip rewriter/wasm/out/wasm_bg.wasm -o rewriter/wasm/out/wasm_snipped.wasm \
	-p 'oxc_regular_expression::.*' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_non_array_type' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_import_type' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_operator_or_higher' \
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_interface_declaration' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_mapped_type' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_index_signature_declaration' \
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_import_equals_declaration' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_or_type_predicate' \
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_namespace_or_module_declaration_body' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_implements_clause' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_intersection_type_or_higher' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type_name' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_literal_type_node' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_asserts_type_predicate' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_tuple_element_type' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_arguments_of_type_reference' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_call_signature_member' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::is_start_of_type' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_this_type_predicate' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_query' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_reference' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_operator' \
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_literal' \
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_at_enum_declaration' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_element' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_identifier' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_element_name' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_children' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_fragment' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_expression_container' \
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_expression'
#
#	these are confirmed to break oxc
#   'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_declaration' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_arguments_in_expression' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type_parameters' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_class_element_modifiers' \
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::eat_decorators' \
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_nth_at_modifier' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::try_parse_type_arguments' \
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_at_ts_index_signature_member' \
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_return_type_annotation' \
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_type_annotation' \


if [ "${RELEASE:-0}" = "1" ]; then
	(
		G="--generate-global-effects"
		FEATURES_OPT="--enable-simd --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue --enable-reference-types"
		if [ "$PROFILE" = "size" ]; then
			# upstream pipeline (size-optimized)
			# shellcheck disable=SC2086
			time wasm-opt $WASMOPTFLAGS $FEATURES_OPT 				rewriter/wasm/out/wasm_snipped.wasm -o rewriter/wasm/out/optimized.wasm 				--converge -tnh --vacuum 				$G -O4 $G --flatten $G --rereloop $G -O4 $G -O4 $G -O4 				$G -Oz $G --flatten $G --rereloop $G -Oz $G -Oz $G -Oz 				$G --code-folding $G --const-hoisting $G --dae $G --flatten $G --merge-locals 				$G -O4 $G --flatten $G --rereloop $G -O4 $G -O4 $G -O4 				$G -Oz $G --flatten $G --rereloop $G -Oz $G -Oz $G -Oz
		else
			# speed pipeline: -O3 to a fixpoint, then drop names/producers (kept until now so wasm-snip can match symbols)
			# shellcheck disable=SC2086
			time wasm-opt $WASMOPTFLAGS $FEATURES_OPT 				rewriter/wasm/out/wasm_snipped.wasm -o rewriter/wasm/out/optimized.wasm 				-tnh $G -O3 $G -O3 --converge 				--strip-debug --strip-producers
		fi
	)
else
	cp rewriter/wasm/out/wasm_snipped.wasm rewriter/wasm/out/optimized.wasm
fi

mkdir -p dist/

cp rewriter/wasm/out/optimized.wasm dist/ramjet.wasm
echo "$SRC_HASH" > rewriter/wasm/out/.build-hash || true
echo "Rewriter Build Complete! profile=${PROFILE} size=$(wc -c < dist/ramjet.wasm) bytes"
