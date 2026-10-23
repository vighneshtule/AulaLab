# Verified kaggle-base environment

A lightweight CPU environment for tabular competitions. This is not an official Kaggle Docker image.

- Recipe: `../environments/kaggle-base.txt` (pinned primary packages and the `base` parent image).
- `kaggle-base.inventory.json`: the complete installed package inventory, including bootstrap packages.
- `kaggle-base.txt`: the result of `pip freeze`.
- `kaggle-base.image.json`: local image, architecture, and image ID recorded after verification.
- `kaggle-base.smoke.json`: training with three boosting libraries and offline checks for the remaining libraries.
- `kaggle-base.submission-check.json`: a real CatBoost submission through the competition API for the parcel-pickup-point dataset; the result is excluded from scoring.

Verify the image:

```sh
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m --user 1000:1000 --cpus 2 --memory 4g -e HOME=/tmp -e MPLCONFIGDIR=/tmp/mpl -e NUMBA_CACHE_DIR=/tmp/numba -v "$PWD/scripts/check-kaggle-base.py:/check.py:ro" aulalab-kernel:kaggle-base python /check.py
```

This snapshot is for the verified local ARM64 build. Build and verify the image separately on other platforms; wheel lists do not transfer automatically between ABIs and architectures.
